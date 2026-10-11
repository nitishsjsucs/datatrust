import { introspectWorkflowInstance } from 'cloudflare:test';
import { env as baseEnv } from 'cloudflare:workers';
import { buildLineageGraph, findUnsanitized } from '@datatrust/rca';
import { describe, expect, it } from 'vitest';
import { investigationIds } from '../src/investigation-ids';
import { getIncident, getJob, getRun, upsertCheckResults, upsertLineageGraph } from '../src/store/repo';
import { s01 } from './helpers/fixtures';

async function seedRun(runId: string) {
  await baseEnv.DB.prepare(`INSERT INTO runs (run_id, target, seed, scenario, status, created_at) VALUES (?, 'duckdb', 101, 'S01', 'failed', ?)`)
    .bind(runId, new Date().toISOString())
    .run();
  await upsertCheckResults(baseEnv.DB, runId, s01.checks);
  await upsertLineageGraph(baseEnv.DB, runId, buildLineageGraph(s01.events, s01.relations));
  await baseEnv.ARTIFACTS.put(`runs/${runId}/relations.json`, JSON.stringify(s01.relations));
}

describe('InvestigationWorkflow', () => {
  it('traces, plans probes, waits for diagnostics, ranks, summarizes and persists an incident', async () => {
    const runId = 'run_inv_1';
    await seedRun(runId);
    const ids = await investigationIds(runId, 'checks');
    const probeKey = `runs/${runId}/probe_results/job_${ids.incidentId}_diag.json`;
    await baseEnv.ARTIFACTS.put(probeKey, JSON.stringify(s01.probeResults));
    await using instance = await introspectWorkflowInstance(baseEnv.INVESTIGATION, ids.instanceId);
    await instance.modify(async (m) => {
      await m.mockEvent({
        type: 'diagnostics-complete',
        payload: { jobId: `job_${ids.incidentId}_diag`, status: 'completed', probeResultsKey: probeKey },
      });
    });
    await baseEnv.INVESTIGATION.create({
      id: ids.instanceId,
      params: { runId, incidentId: ids.incidentId, trigger: 'checks' },
    });
    await instance.waitForStatus('complete');

    // The diagnostics job carries probe invocations, never SQL.
    const job = await getJob(baseEnv.DB, `job_${ids.incidentId}_diag`);
    const payload = JSON.parse(job!.payload_json) as { probes: Array<Record<string, unknown>>; target: string };
    expect(payload.target).toBe('duckdb');
    expect(payload.probes.length).toBeGreaterThan(5);
    expect(payload.probes.every((p) => !('sql' in p))).toBe(true);

    const row = await getIncident(baseEnv.DB, ids.incidentId);
    expect(row).not.toBeNull();
    const ranked = JSON.parse(row!.ranked_json) as Array<{ node: string }>;
    expect(ranked[0]!.node).toBe('source.datatrust.raw.hires');
    expect((await getRun(baseEnv.DB, runId))?.incident_id).toBe(ids.incidentId);

    const stored = await baseEnv.ARTIFACTS.get(`incidents/${ids.incidentId}.json`);
    const incident = (await stored!.json()) as {
      diagnosticSql: Array<{ sql: string[] }>;
      provenance: Record<string, unknown>;
      evidence: { probes: Parameters<typeof findUnsanitized>[0] };
      failingChecks: Array<{ checkId: string }>;
    };
    expect(incident.failingChecks.map((c) => c.checkId)).toEqual(['U05']);
    expect(incident.diagnosticSql.length).toBeGreaterThan(0);
    expect(incident.diagnosticSql[0]!.sql[0]).toMatch(/^with grouped as/);
    expect(incident.provenance['warehouse']).toBe('duckdb (local stand-in for BigQuery)');
    expect(incident.provenance['lakeSink']).toBe(
      'queue datatrust-audit-events, R2 lake/ objects, pyiceberg SQL catalog (local stand-in for Basin Catalog)',
    );
    expect(JSON.stringify(incident.evidence)).not.toMatch(/@example\.com/);
  });

  it('still ranks (without probes) when diagnostics time out', async () => {
    const runId = 'run_inv_2';
    await seedRun(runId);
    const ids = await investigationIds(runId, 'checks');
    await using instance = await introspectWorkflowInstance(baseEnv.INVESTIGATION, ids.instanceId);
    await instance.modify(async (m) => {
      await m.forceEventTimeout({ name: 'wait-diagnostics' });
    });
    await baseEnv.INVESTIGATION.create({ id: ids.instanceId, params: { runId, incidentId: ids.incidentId, trigger: 'checks' } });
    await instance.waitForStatus('complete');
    const row = await getIncident(baseEnv.DB, ids.incidentId);
    const provenance = JSON.parse(row!.provenance_json) as { probes: { diagnostics: string } };
    expect(provenance.probes.diagnostics).toBe('timeout');
    expect((JSON.parse(row!.ranked_json) as unknown[]).length).toBeGreaterThan(0);
  });

  it('adds evidence-only time-travel probes against the last green run of the same target', async () => {
    const green = 'run_green_1';
    const earlier = new Date(Date.now() - 3_600_000).toISOString();
    await baseEnv.DB.prepare(
      `INSERT INTO runs (run_id, target, seed, scenario, status, created_at, finished_at) VALUES (?, 'duckdb', 101, NULL, 'passed', ?, ?)`,
    )
      .bind(green, earlier, earlier)
      .run();
    // A passed BigQuery run is newer but has another target, so it is not the baseline for a DuckDB run.
    await baseEnv.DB.prepare(
      `INSERT INTO runs (run_id, target, seed, scenario, status, created_at, finished_at) VALUES ('run_green_bq', 'bigquery', 101, NULL, 'passed', ?, ?)`,
    )
      .bind(new Date(Date.now() - 60_000).toISOString(), new Date(Date.now() - 60_000).toISOString())
      .run();
    const runId = 'run_inv_4';
    await seedRun(runId);
    const ids = await investigationIds(runId, 'checks');
    const probeKey = `runs/${runId}/probe_results/job_${ids.incidentId}_diag.json`;
    const delta = {
      probeId: 'delta_vs_last_green:model.datatrust.fct_hires:',
      probe: 'delta_vs_last_green',
      node: 'model.datatrust.fct_hires',
      columns: [],
      metric: 'rowcount_vs_last_green',
      value: 1.04,
      anomaly: 0,
      sql: ['select 1'],
      dialect: 'duckdb',
      status: 'ok',
      sampleKeys: [],
      details: { n_rows_now: 374, n_rows_then: 360 },
    };
    await baseEnv.ARTIFACTS.put(probeKey, JSON.stringify([...s01.probeResults, delta]));
    await using instance = await introspectWorkflowInstance(baseEnv.INVESTIGATION, ids.instanceId);
    await instance.modify(async (m) => {
      await m.mockEvent({
        type: 'diagnostics-complete',
        payload: { jobId: `job_${ids.incidentId}_diag`, status: 'completed', probeResultsKey: probeKey },
      });
    });
    await baseEnv.INVESTIGATION.create({ id: ids.instanceId, params: { runId, incidentId: ids.incidentId, trigger: 'checks' } });
    await instance.waitForStatus('complete');

    const job = await getJob(baseEnv.DB, `job_${ids.incidentId}_diag`);
    const payload = JSON.parse(job!.payload_json) as { probes: Array<{ probe: string; node: string; params: Record<string, unknown> }> };
    const tt = payload.probes.filter((p) => p.probe === 'delta_vs_last_green');
    expect(tt.map((p) => p.node)).toContain('model.datatrust.fct_hires');
    expect(tt.every((p) => p.params['lastGreenRunId'] === green && typeof p.params['lastGreenFinishedAtMs'] === 'number')).toBe(true);
    // Only mart tables have local snapshots; sources and views get no time-travel probe on DuckDB.
    expect(tt.some((p) => p.node.startsWith('source.') || p.node.includes('.stg_'))).toBe(false);

    const row = await getIncident(baseEnv.DB, ids.incidentId);
    const provenance = JSON.parse(row!.provenance_json) as { timeTravel: { lastGreenRunId: string; nodes: Array<Record<string, unknown>> } };
    expect(provenance.timeTravel.lastGreenRunId).toBe(green);
    expect(provenance.timeTravel.nodes).toEqual([{ node: 'model.datatrust.fct_hires', rowsNow: 374, rowsThen: 360 }]);
    // Evidence only: the ranking is unchanged by the time-travel result.
    expect((JSON.parse(row!.ranked_json) as Array<{ node: string }>)[0]!.node).toBe('source.datatrust.raw.hires');
  });

  it('investigates a failed metric reported as an alert', async () => {
    const runId = 'run_inv_3';
    await seedRun(runId);
    const alert = { runId, metricNode: 'model.datatrust.metric_hires_monthly', column: 'hires', observed: 365, expected: 360 };
    const ids = await investigationIds(runId, 'alert', alert);
    await using instance = await introspectWorkflowInstance(baseEnv.INVESTIGATION, ids.instanceId);
    await instance.modify(async (m) => {
      await m.forceEventTimeout({ name: 'wait-diagnostics' });
    });
    await baseEnv.INVESTIGATION.create({ id: ids.instanceId, params: { runId, incidentId: ids.incidentId, trigger: 'alert', alert } });
    await instance.waitForStatus('complete');
    const trace = JSON.parse((await instance.waitForStepResult({ name: 'trace-lineage' })) as string) as {
      failing: string[];
      candidates: Array<{ node: string }>;
    };
    expect(trace.failing).toContain('alert:metric_hires_monthly');
    expect(trace.candidates.map((c) => c.node)).toContain('model.datatrust.fct_hires');
    expect(trace.candidates.map((c) => c.node)).toContain('source.datatrust.raw.hires');
  });
});
