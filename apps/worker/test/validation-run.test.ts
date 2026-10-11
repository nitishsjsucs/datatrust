import { introspectWorkflowInstance } from 'cloudflare:test';
import { env as baseEnv } from 'cloudflare:workers';
import { buildLineageGraph } from '@datatrust/rca';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AppEnv } from '../src/env';
import { getJob, getRun, lineageBundleStatements, upsertCheckResults, upsertLineageGraph } from '../src/store/repo';
import { request } from './helpers/app';
import { s01 } from './helpers/fixtures';
import { humanClaims, type Keys, makeKeys, mint, OPERATOR, testEnv } from './helpers/keys';

let keys: Keys;
let env: AppEnv;
let operator: string;

beforeAll(async () => {
  keys = await makeKeys();
  env = testEnv(keys);
  operator = await mint(keys, humanClaims(OPERATOR));
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

  it('retries await-ingested until the queues have caught up', async () => {
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
  });
});
