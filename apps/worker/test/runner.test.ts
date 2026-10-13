import { env as baseEnv } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AppEnv } from '../src/env';
import { getJob, insertJob, insertRun } from '../src/store/repo';
import { request } from './helpers/app';
import { s01 } from './helpers/fixtures';
import { leasedBuildJob, recordingQueue } from './helpers/jobs';
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

/** A VALIDATION_RUN stand-in whose sendEvent fails `failures` times before it records events. */
function flakyWorkflow(failures: number) {
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  let left = failures;
  const binding = {
    get: async () => ({
      sendEvent: async (e: { type: string; payload: Record<string, unknown> }) => {
        if (left-- > 0) throw new Error('network connection lost');
        sent.push(e);
      },
      status: async () => ({ status: 'waiting' }),
    }),
  } as unknown as Workflow;
  return { binding, sent };
}

describe('job completion is safe to retry', () => {
  it('delivers the event on a retry with the same token after the first event send failed', async () => {
    const headers = await leasedBuildJob('run_retry1');
    const wf = flakyWorkflow(1);
    const q = recordingQueue();
    const e = { ...env, VALIDATION_RUN: wf.binding, CHECK_RESULTS_Q: q.queue };
    const body = { status: 'completed', checkResults: s01.checks, expectedLineageEvents: 3 };
    const path = '/api/runner/jobs/job_run_retry1_build/complete';
    const first = await request(e, 'POST', path, { token: runnerToken, headers, body });
    expect(first.status).toBe(500);
    expect((await getJob(baseEnv.DB, 'job_run_retry1_build'))?.status).toBe('completed');

    const second = await request(e, 'POST', path, { token: runnerToken, headers, body });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ ok: true, repeat: true, checkMessages: 0, event: 'delivered' });
    expect(wf.sent).toHaveLength(1);
    expect(wf.sent[0]!.type).toBe('build-complete');
    expect(wf.sent[0]!.payload).toMatchObject({ jobId: 'job_run_retry1_build', status: 'completed', checkCount: 40, expectedLineageEvents: 3 });
    // The check results went out once, with the first call.
    expect(q.bodies).toHaveLength(1);

    // A different outcome for the same job is a conflict; another token is still refused.
    expect((await request(e, 'POST', path, { token: runnerToken, headers, body: { status: 'failed' } })).status).toBe(409);
    const foreign = { ...headers, 'X-DataTrust-Lease-Token': 'not-the-holder' };
    expect((await request(e, 'POST', path, { token: runnerToken, headers: foreign, body })).status).toBe(403);
  });

  it("forwards the runner's failed metric with the build event and refuses a malformed one", async () => {
    const headers = await leasedBuildJob('run_metric1');
    const wf = flakyWorkflow(0);
    const e = { ...env, VALIDATION_RUN: wf.binding, CHECK_RESULTS_Q: recordingQueue().queue };
    const passing = s01.checks.map((c) => ({ ...c, status: 'pass' as const, failures: 0 }));
    const metricAlert = { metricNode: 'model.datatrust.metric_hires_monthly', column: 'hires', observed: 3, expected: 2 };
    const path = '/api/runner/jobs/job_run_metric1_build/complete';
    const bad = { status: 'completed', checkResults: passing, metricAlert: { ...metricAlert, metricNode: 'raw.hires' } };
    expect((await request(e, 'POST', path, { token: runnerToken, headers, body: bad })).status).toBe(400);
    const res = await request(e, 'POST', path, {
      token: runnerToken,
      headers,
      body: { status: 'completed', checkResults: passing, expectedLineageEvents: 3, metricAlert },
    });
    expect(res.status).toBe(200);
    expect(wf.sent[0]!.payload).toMatchObject({ status: 'completed', checkCount: 40, metricAlert });
  });

  it('answers 200 when the workflow instance no longer exists (Free plan retention)', async () => {
    const headers = await leasedBuildJob('run_gone1');
    const e = { ...env, CHECK_RESULTS_Q: recordingQueue().queue };
    const res = await request(e, 'POST', '/api/runner/jobs/job_run_gone1_build/complete', {
      token: runnerToken,
      headers,
      body: { status: 'completed', checkResults: s01.checks, expectedLineageEvents: 3 },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, repeat: false, event: 'instance_gone' });
    expect((await getJob(baseEnv.DB, 'job_run_gone1_build'))?.status).toBe('completed');
  });

  it("keeps accepting the holder's token after the lease expired while nobody re-leased the job", async () => {
    const headers = await leasedBuildJob('run_late1');
    await baseEnv.DB.prepare(`UPDATE jobs SET lease_expires_at = 1 WHERE job_id = 'job_run_late1_build'`).run();
    const rel = await request(env, 'POST', '/api/runner/jobs/job_run_late1_build/artifacts', {
      token: runnerToken,
      headers,
      body: { kind: 'relations', data: s01.relations },
    });
    expect(rel.status).toBe(200);
    const wf = flakyWorkflow(0);
    const e = { ...env, VALIDATION_RUN: wf.binding, CHECK_RESULTS_Q: recordingQueue().queue };
    const done = await request(e, 'POST', '/api/runner/jobs/job_run_late1_build/complete', {
      token: runnerToken,
      headers,
      body: { status: 'completed', checkResults: s01.checks, expectedLineageEvents: 3 },
    });
    expect(done.status).toBe(200);
    expect(wf.sent).toHaveLength(1);
  });

  it('refuses the old token once another runner re-leased the expired job', async () => {
    await insertJob(baseEnv.DB, {
      jobId: 'job_relet_build',
      runId: 'run_relet',
      kind: 'dbt_build',
      payload: { runId: 'run_relet', target: 'bigquery' },
      workflowInstanceId: 'run_relet',
      eventType: 'build-complete',
    });
    await baseEnv.DB.prepare(
      `UPDATE jobs SET status = 'leased', lease_token = 'old', attempts = 1, lease_expires_at = 1 WHERE job_id = 'job_relet_build'`,
    ).run();
    const again = await lease(['dbt_build'], 'bigquery');
    expect(again.status).toBe(200);
    const { job } = (await again.json()) as { job: { jobId: string; leaseToken: string } };
    expect(job.jobId).toBe('job_relet_build');
    expect(job.leaseToken).not.toBe('old');
    const old = { 'X-DataTrust-Lease-Token': 'old', 'X-DataTrust-Job-Id': 'job_relet_build' };
    expect(
      (await request(env, 'POST', '/api/runner/jobs/job_relet_build/complete', { token: runnerToken, headers: old, body: { status: 'failed' } })).status,
    ).toBe(403);
  });
});

describe('jobs past their workflow wait', () => {
  it('are failed by the lease sweep and never leased', async () => {
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    for (const [jobId, kind, age] of [
      ['job_old_build', 'dbt_build', 7],
      ['job_old_diag', 'diagnostics', 2],
      ['job_young_diag', 'diagnostics', 0.5],
    ] as const) {
      await insertJob(baseEnv.DB, {
        jobId,
        runId: 'run_old',
        kind,
        payload: { runId: 'run_old', target: 'duckdb', probes: [] },
        workflowInstanceId: `wf_${jobId}`,
        eventType: kind === 'dbt_build' ? 'build-complete' : 'diagnostics-complete',
      });
      await baseEnv.DB.prepare(`UPDATE jobs SET created_at = ? WHERE job_id = ?`).bind(hoursAgo(age), jobId).run();
    }
    const res = await lease(['dbt_build', 'diagnostics']);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { job: { jobId: string } }).job.jobId).toBe('job_young_diag');
    expect((await getJob(baseEnv.DB, 'job_old_build'))?.status).toBe('failed');
    expect((await getJob(baseEnv.DB, 'job_old_diag'))?.status).toBe('failed');
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
