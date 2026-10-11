import { env as baseEnv } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AppEnv } from '../src/env';
import { getJob, insertJob, insertRun } from '../src/store/repo';
import { request } from './helpers/app';
import { s01 } from './helpers/fixtures';
import { humanClaims, type Keys, makeKeys, mint, OPERATOR, serviceClaims, testEnv, VIEWER } from './helpers/keys';

let keys: Keys;
let env: AppEnv;
let runnerToken: string;
let operatorToken: string;

beforeAll(async () => {
  keys = await makeKeys();
  env = testEnv(keys);
  runnerToken = await mint(keys, serviceClaims());
  operatorToken = await mint(keys, humanClaims(OPERATOR));
});

async function lease(kinds = ['dbt_build'], target = 'duckdb') {
  return request(env, 'POST', '/api/runner/lease', { token: runnerToken, body: { runnerId: 'r1', kinds, target } });
}

describe('runner lease protocol', () => {
  it('leases the oldest eligible job once, then answers 204', async () => {
    await insertRun(baseEnv.DB, { runId: 'run_r1', target: 'duckdb', seed: 101, scenario: null });
    await insertJob(baseEnv.DB, {
      jobId: 'job_r1_build',
      runId: 'run_r1',
      kind: 'dbt_build',
      payload: { runId: 'run_r1', target: 'duckdb', seed: 101, scenario: null },
      workflowInstanceId: 'run_r1',
      eventType: 'build-complete',
    });
    const first = await lease();
    expect(first.status).toBe(200);
    const { job } = (await first.json()) as { job: { jobId: string; leaseToken: string; attempts: number; payload: unknown } };
    expect(job.jobId).toBe('job_r1_build');
    expect(job.attempts).toBe(1);
    expect(job.leaseToken).toMatch(/^[0-9a-f]{48}$/);
    expect((await lease()).status).toBe(204);
    expect((await lease(['dbt_build'], 'bigquery')).status).toBe(204);
  });

  it('only lets the runner role lease', async () => {
    const res = await request(env, 'POST', '/api/runner/lease', {
      token: operatorToken,
      body: { runnerId: 'r1', kinds: ['dbt_build'], target: 'duckdb' },
    });
    expect(res.status).toBe(403);
  });

  it('stops leasing a job after 3 attempts and fails it when its lease expires', async () => {
    await insertJob(baseEnv.DB, {
      jobId: 'job_r2_build',
      runId: 'run_r2',
      kind: 'dbt_build',
      payload: { runId: 'run_r2', target: 'bigquery' },
      workflowInstanceId: 'run_r2_missing_instance',
      eventType: 'build-complete',
    });
    await baseEnv.DB.prepare(`UPDATE jobs SET status = 'leased', attempts = 3, lease_expires_at = 1 WHERE job_id = 'job_r2_build'`).run();
    const res = await lease(['dbt_build'], 'bigquery');
    expect(res.status).toBe(204);
    expect((await getJob(baseEnv.DB, 'job_r2_build'))?.status).toBe('failed');
  });

  it('rejects artifact and lineage uploads without the current lease token', async () => {
    const bad = { 'X-DataTrust-Lease-Token': 'stale' };
    expect(
      (await request(env, 'POST', '/api/runner/jobs/job_r1_build/artifacts', { token: runnerToken, headers: bad, body: { kind: 'relations', data: {} } })).status,
    ).toBe(403);
    expect(
      (await request(env, 'POST', '/api/v1/lineage', { token: runnerToken, headers: { ...bad, 'X-DataTrust-Job-Id': 'job_r1_build' }, body: s01.events[0] })).status,
    ).toBe(403);
  });

  it('accepts relations, OpenLineage events and run results with a valid lease', async () => {
    const leaseToken = (await getJob(baseEnv.DB, 'job_r1_build'))!.lease_token!;
    const headers = { 'X-DataTrust-Lease-Token': leaseToken, 'X-DataTrust-Job-Id': 'job_r1_build' };
    const rel = await request(env, 'POST', '/api/runner/jobs/job_r1_build/artifacts', {
      token: runnerToken,
      headers,
      body: { kind: 'relations', data: s01.relations },
    });
    expect(rel.status).toBe(200);
    expect(await baseEnv.ARTIFACTS.get('runs/run_r1/relations.json')).not.toBeNull();
    const ol = await request(env, 'POST', '/api/v1/lineage', { token: runnerToken, headers, body: s01.events.slice(0, 3) });
    expect(ol.status).toBe(202);
    const body = (await ol.json()) as { accepted: number; eventIds: string[] };
    expect(body.accepted).toBe(3);
    expect(new Set(body.eventIds).size).toBe(3);
    // the same event again maps to the same id (content hash)
    const again = (await (await request(env, 'POST', '/api/v1/lineage', { token: runnerToken, headers, body: s01.events[0] })).json()) as {
      eventIds: string[];
    };
    expect(again.eventIds[0]).toBe(body.eventIds[0]);
    expect((await request(env, 'POST', '/api/v1/lineage', { token: runnerToken, headers, body: { not: 'an event' } })).status).toBe(400);
  });

  it('answers 422 to probe results that still carry raw identifiers', async () => {
    await insertJob(baseEnv.DB, {
      jobId: 'job_r1_diag',
      runId: 'run_r1',
      kind: 'diagnostics',
      payload: { runId: 'run_r1', target: 'duckdb', probes: [] },
      workflowInstanceId: 'inv_missing',
      eventType: 'diagnostics-complete',
    });
    const leased = (await (await lease(['diagnostics'])).json()) as { job: { leaseToken: string } };
    const headers = { 'X-DataTrust-Lease-Token': leased.job.leaseToken };
    const raw = s01.probeResults.map((r) =>
      r.probe === 'dup_key_rate' && r.sampleKeys.length ? { ...r, sampleKeys: [{ application_id: 1042 }] } : r,
    );
    const res = await request(env, 'POST', '/api/runner/jobs/job_r1_diag/complete', {
      token: runnerToken,
      headers,
      body: { status: 'completed', probeResults: raw },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; violations: Array<{ reason: string }> };
    expect(body.error).toBe('unsanitized');
    expect(body.violations[0]!.reason).toBe('identifier is not an HMAC token');
  });
});

describe('alerts', () => {
  it('404s an unknown run and accepts an alert on a known run', async () => {
    const alert = { runId: 'run_nope', metricNode: 'model.datatrust.metric_hires_monthly', observed: 1, expected: 2 };
    expect((await request(env, 'POST', '/api/alerts', { token: operatorToken, body: alert })).status).toBe(404);
    const ok = await request(env, 'POST', '/api/alerts', { token: runnerToken, body: { ...alert, runId: 'run_r1' } });
    expect(ok.status).toBe(202);
    expect(((await ok.json()) as { incidentId: string }).incidentId).toMatch(/^inc_run_r1_alert_[0-9a-f]{8}$/);
    const viewer = await mint(keys, humanClaims(VIEWER));
    expect((await request(env, 'POST', '/api/alerts', { token: viewer, body: alert })).status).toBe(403);
  });
});
