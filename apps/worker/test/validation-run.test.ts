import { introspectWorkflowInstance } from 'cloudflare:test';
import { env as baseEnv } from 'cloudflare:workers';
import { buildLineageGraph } from '@datatrust/rca';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AppEnv } from '../src/env';
import { getJob, getRun, lineageBundleStatements, upsertCheckResults, upsertLineageGraph } from '../src/store/repo';
import { awaitIngested } from '../src/workflows/validation-run';
import { request } from './helpers/app';
import { s01 } from './helpers/fixtures';
import { humanClaims, type Keys, makeKeys, mint, OPERATOR, serviceClaims, testEnv } from './helpers/keys';

let keys: Keys;
let env: AppEnv;
let operator: string;
let runner: string;

beforeAll(async () => {
  keys = await makeKeys();
  env = testEnv(keys);
  operator = await mint(keys, humanClaims(OPERATOR));
  runner = await mint(keys, serviceClaims());
});

async function createRun(): Promise<string> {
  const res = await request(env, 'POST', '/api/runs', { token: operator, body: { target: 'duckdb', seed: 101, scenario: 'S01' } });
  expect(res.status).toBe(201);
  return ((await res.json()) as { runId: string }).runId;
}

/** What the queue consumers would have written for this run. */
async function ingest(runId: string, checks = s01.checks, lineageEvents = 3) {
  await upsertCheckResults(baseEnv.DB, runId, checks);
  await upsertLineageGraph(baseEnv.DB, runId, buildLineageGraph(s01.events, s01.relations));
  const events = Array.from({ length: lineageEvents }, (_, i) => ({ eventId: `e${i}`, r2Key: `lineage/${runId}/e${i}.json` }));
  await baseEnv.DB.batch(lineageBundleStatements(baseEnv.DB, runId, [], events));
}

describe('ValidationRunWorkflow', () => {
  it('inserts the run row before the workflow starts, so an immediate GET never 404s', async () => {
    const res = await request(env, 'POST', '/api/runs', { token: operator, body: { target: 'duckdb' } });
    const { runId } = (await res.json()) as { runId: string };
    const get = await request(env, 'GET', `/api/runs/${runId}`, { token: operator });
    expect(get.status).toBe(200);
    expect(runId).toMatch(/^run_[0-9A-Z]{26}$/);
  });

  it('runs build -> ingest -> summarize -> dispatch -> finalize for a failing run', async () => {
    const runId = 'run_wf_fail';
    await using instance = await introspectWorkflowInstance(baseEnv.VALIDATION_RUN, runId);
    await instance.modify(async (m) => {
      await m.disableRetryDelays();
      await m.mockEvent({
        type: 'build-complete',
        payload: { jobId: `job_${runId}_build`, status: 'completed', checkCount: 40, expectedLineageEvents: 3 },
      });
      await m.mockStepResult({ name: 'dispatch-investigation' }, JSON.stringify({ instanceId: 'mocked' }));
    });
    await ingest(runId);
    await baseEnv.DB.prepare(`INSERT INTO runs (run_id, target, seed, scenario, status, created_at) VALUES (?, 'duckdb', 101, 'S01', 'queued', ?)`)
      .bind(runId, new Date().toISOString())
      .run();
    await baseEnv.VALIDATION_RUN.create({ id: runId, params: { runId, target: 'duckdb', seed: 101, scenario: 'S01' } });
    await instance.waitForStatus('complete');
    const job = await getJob(baseEnv.DB, `job_${runId}_build`);
    expect(job?.kind).toBe('dbt_build');
    expect(JSON.parse(job!.payload_json)).toEqual({ runId, target: 'duckdb', seed: 101, scenario: 'S01' });
    const summary = JSON.parse((await instance.waitForStepResult({ name: 'summarize-run' })) as string);
    expect(summary.failing).toEqual(['U05']);
    expect(summary.pass + summary.fail + summary.error + summary.skip).toBe(40);
    expect(await instance.waitForStepResult({ name: 'dispatch-investigation' })).toBe(JSON.stringify({ instanceId: 'mocked' }));
    const run = await getRun(baseEnv.DB, runId);
    expect(run?.status).toBe('failed');
    expect(run?.n_fail).toBe(1);
    expect(run?.workflow_instance_id).toBe(runId);
  });

  it('awaitIngested throws until every check result and lineage event is in D1', async () => {
    const runId = 'run_barrier_unit';
    const build = { jobId: `job_${runId}_build`, status: 'completed' as const, checkCount: 40, expectedLineageEvents: 3 };
    const lineage = (n: number) => Array.from({ length: n }, (_, i) => ({ eventId: `e${i}`, r2Key: `lineage/${runId}/e${i}.json` }));
    expect(s01.checks).toHaveLength(40);
    await upsertCheckResults(baseEnv.DB, runId, s01.checks.slice(0, 39));
    await baseEnv.DB.batch(lineageBundleStatements(baseEnv.DB, runId, [], lineage(3)));
    await expect(awaitIngested(baseEnv.DB, runId, build)).rejects.toThrow('not yet ingested: checks 39/40, lineage 3/3');
    await upsertCheckResults(baseEnv.DB, runId, s01.checks);
    await expect(awaitIngested(baseEnv.DB, runId, { ...build, expectedLineageEvents: 4 })).rejects.toThrow(
      'not yet ingested: checks 40/40, lineage 3/4',
    );
    expect(await awaitIngested(baseEnv.DB, runId, build)).toEqual({ checks: 40, lineage: 3 });
  });

  it('ends the run as error, and fails its open jobs, when the queues never catch up', async () => {
    const runId = 'run_wf_short';
    await using instance = await introspectWorkflowInstance(baseEnv.VALIDATION_RUN, runId);
    await instance.modify(async (m) => {
      await m.disableRetryDelays();
      await m.mockEvent({
        type: 'build-complete',
        payload: { jobId: `job_${runId}_build`, status: 'completed', checkCount: 40, expectedLineageEvents: 3 },
      });
    });
    // One check result short: a dead-lettered message never arrives.
    await ingest(runId, s01.checks.slice(0, 39));
    await baseEnv.DB.prepare(`INSERT INTO runs (run_id, target, status, created_at) VALUES (?, 'duckdb', 'queued', ?)`)
      .bind(runId, new Date().toISOString())
      .run();
    await baseEnv.VALIDATION_RUN.create({ id: runId, params: { runId, target: 'duckdb', seed: 101, scenario: null } });
    await instance.waitForStatus('complete');
    expect(await instance.waitForStepResult({ name: 'mark-ingest-error' })).toBe(JSON.stringify({ status: 'error' }));
    const run = await getRun(baseEnv.DB, runId);
    expect(run?.status).toBe('error');
    expect(run?.finished_at).not.toBeNull();
    expect((await getJob(baseEnv.DB, `job_${runId}_build`))?.status).toBe('failed');
  });

  it('finishes once await-ingested succeeds after two failed attempts', async () => {
    const runId = 'run_wf_retry';
    await using instance = await introspectWorkflowInstance(baseEnv.VALIDATION_RUN, runId);
    await instance.modify(async (m) => {
      await m.disableRetryDelays();
      await m.mockEvent({
        type: 'build-complete',
        payload: { jobId: `job_${runId}_build`, status: 'completed', checkCount: 40, expectedLineageEvents: 3 },
      });
      await m.mockStepError({ name: 'await-ingested' }, new Error('not yet ingested'), 2);
    });
    await ingest(runId, s01.checks.map((c) => ({ ...c, status: 'pass' as const, failures: 0 })));
    await baseEnv.DB.prepare(`INSERT INTO runs (run_id, target, status, created_at) VALUES (?, 'duckdb', 'queued', ?)`)
      .bind(runId, new Date().toISOString())
      .run();
    await baseEnv.VALIDATION_RUN.create({ id: runId, params: { runId, target: 'duckdb', seed: 101, scenario: null } });
    await instance.waitForStatus('complete');
    expect((await getRun(baseEnv.DB, runId))?.status).toBe('passed');
  });

  it('marks the run stale when no build-complete event arrives', async () => {
    const runId = 'run_wf_stale';
    await using instance = await introspectWorkflowInstance(baseEnv.VALIDATION_RUN, runId);
    await instance.modify(async (m) => {
      await m.forceEventTimeout({ name: 'wait-build' });
    });
    await baseEnv.DB.prepare(`INSERT INTO runs (run_id, target, status, created_at) VALUES (?, 'duckdb', 'queued', ?)`)
      .bind(runId, new Date().toISOString())
      .run();
    await baseEnv.VALIDATION_RUN.create({ id: runId, params: { runId, target: 'duckdb', seed: 101, scenario: null } });
    await instance.waitForStatus('complete');
    expect((await getRun(baseEnv.DB, runId))?.status).toBe('stale');
    // The build job of a stale run is failed, so no runner leases it later (other tests' jobs may be queued).
    expect((await getJob(baseEnv.DB, `job_${runId}_build`))?.status).toBe('failed');
    const leased: string[] = [];
    for (let i = 0; i < 10; i++) {
      const res = await request(env, 'POST', '/api/runner/lease', {
        token: runner,
        body: { runnerId: 'r-stale', kinds: ['dbt_build'], target: 'duckdb' },
      });
      if (res.status === 204) break;
      leased.push(((await res.json()) as { job: { jobId: string } }).job.jobId);
    }
    expect(leased.length).toBeLessThan(10);
    expect(leased).not.toContain(`job_${runId}_build`);
  });
});
