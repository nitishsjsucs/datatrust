/**
 * D1 statements per invocation stay far below the Free plan's 50 (SPEC 28.5.3, 28.7): every multi-row write
 * is one set-based statement, so the counts below hold whatever the number of rows, and whichever way D1
 * counts a batch.
 */
import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test';
import { env as baseEnv } from 'cloudflare:workers';
import { buildEvidence, buildLineageGraph, type CheckResult } from '@datatrust/rca';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AppEnv } from '../src/env';
import worker from '../src/index';
import { summarizeAttempt } from '../src/llm/attempt';
import { WorkersAISummarizer } from '../src/llm/workers-ai';
import { QUEUES } from '../src/queues/router';
import {
  finishRun,
  insertJob,
  insertRun,
  lineageBundleStatements,
  listCheckResults,
  loadLineageGraph,
  markRunRunning,
  upsertCheckResults,
  upsertLineageGraph,
} from '../src/store/repo';
import { loadContext, persistIncidentRows } from '../src/workflows/investigation';
import { awaitIngested, summarizeRun } from '../src/workflows/validation-run';
import { request } from './helpers/app';
import { type Counter, countingDb } from './helpers/counting-db';
import { s01 } from './helpers/fixtures';
import { leasedBuildJob, recordingQueue } from './helpers/jobs';
import { type Keys, makeKeys, mint, serviceClaims, testEnv } from './helpers/keys';

let keys: Keys;
let runner: string;

beforeAll(async () => {
  keys = await makeKeys();
  runner = await mint(keys, serviceClaims());
});

function counted(extra: Partial<AppEnv> = {}): { env: AppEnv; counter: Counter } {
  const { db, counter } = countingDb(baseEnv.DB);
  return { env: { ...testEnv(keys), ...extra, DB: db }, counter };
}

async function deliver(e: AppEnv, queue: string, bodies: unknown[]) {
  const batch = createMessageBatch(
    queue,
    bodies.map((body, i) => ({ id: `m${i}`, timestamp: new Date(), attempts: 1, body })),
  );
  await worker.queue(batch, e);
  return getQueueResult(batch, createExecutionContext());
}

const largestTen = () =>
  [...s01.events].sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length).slice(0, 10);

describe('D1 statements per invocation', () => {
  it('relations upload of 42 nodes: 2 (job lookup, one node upsert)', async () => {
    const headers = await leasedBuildJob('run_d1_rel');
    const { env, counter } = counted();
    const res = await request(env, 'POST', '/api/runner/jobs/job_run_d1_rel_build/artifacts', {
      token: runner,
      headers,
      body: { kind: 'relations', data: s01.relations },
    });
    expect(res.status).toBe(200);
    expect(Object.keys(s01.relations.nodes)).toHaveLength(42);
    expect(counter.statements).toBe(2);
    expect(Object.keys((await loadLineageGraph(baseEnv.DB, 'run_d1_rel')).nodes)).toHaveLength(42);
  });

  it('lineage POST of the 10 largest seed-101 events: 1; its bundle: 2', async () => {
    const runId = 'run_d1_ol';
    const headers = await leasedBuildJob(runId);
    await baseEnv.ARTIFACTS.put(`runs/${runId}/relations.json`, JSON.stringify(s01.relations));
    const { queue, bodies } = recordingQueue();
    const post = counted({ LINEAGE_Q: queue });
    const res = await request(post.env, 'POST', '/api/v1/lineage', { token: runner, headers, body: largestTen() });
    expect(res.status).toBe(202);
    expect(post.counter.statements).toBe(1);
    expect(bodies).toHaveLength(1);
    const consume = counted();
    expect((await deliver(consume.env, QUEUES.lineageEvents, bodies)).retryMessages).toEqual([]);
    expect(consume.counter.statements).toBe(2);
  });

  it('check-results batch of 10 messages: at most 10', async () => {
    const bodies = Array.from({ length: 10 }, (_, i) => ({ runId: `run_d1_chk_${i}`, checkResults: s01.checks }));
    const { queue } = recordingQueue();
    const { env, counter } = counted({ AUDIT_Q: queue });
    const result = await deliver(env, QUEUES.checkResults, bodies);
    expect(result.explicitAcks).toHaveLength(10);
    expect(counter.statements).toBeLessThanOrEqual(10);
    expect(await listCheckResults(baseEnv.DB, 'run_d1_chk_9')).toHaveLength(40);
  });

  it('DLQ batch of 10 messages: 1', async () => {
    const { env, counter } = counted();
    const result = await deliver(env, QUEUES.dlq, Array.from({ length: 10 }, (_, i) => ({ poison: i })));
    expect(result.explicitAcks).toHaveLength(10);
    expect(counter.statements).toBe(1);
    const n = await baseEnv.DB.prepare(`SELECT count(*) AS n FROM dead_letters WHERE body_json LIKE '{"poison":%'`).first<{ n: number }>();
    expect(n?.n).toBeGreaterThanOrEqual(10);
  });

  it('investigate batch of 5 messages: at most 5 (one incident lookup each)', async () => {
    const created: unknown[] = [];
    const workflow = { create: async (o: unknown) => void created.push(o) } as unknown as Workflow;
    const { env, counter } = counted({ INVESTIGATION: workflow });
    const bodies = Array.from({ length: 5 }, (_, i) => ({ runId: `run_d1_inv_${i}`, incidentId: `inc_run_d1_inv_${i}_checks_00000000`, trigger: 'checks' }));
    const result = await deliver(env, QUEUES.investigate, bodies);
    expect(result.explicitAcks).toHaveLength(5);
    expect(created).toHaveLength(5);
    expect(counter.statements).toBeLessThanOrEqual(5);
  });

  it('runner lease and build completion: at most 2 each', async () => {
    await insertJob(baseEnv.DB, {
      jobId: 'job_d1_lease',
      runId: 'run_d1_lease',
      kind: 'dbt_build',
      payload: { target: 'duckdb' },
      workflowInstanceId: 'run_d1_lease',
      eventType: 'build-complete',
    });
    const lease = counted();
    const res = await request(lease.env, 'POST', '/api/runner/lease', {
      token: runner,
      body: { runnerId: 'd1', kinds: ['dbt_build'], target: 'duckdb' },
    });
    expect([200, 204]).toContain(res.status);
    expect(lease.counter.statements).toBeLessThanOrEqual(2);

    const headers = await leasedBuildJob('run_d1_done');
    const { queue } = recordingQueue();
    const sent: unknown[] = [];
    const workflow = { get: async () => ({ sendEvent: async (e: unknown) => void sent.push(e) }) } as unknown as Workflow;
    const done = counted({ CHECK_RESULTS_Q: queue, VALIDATION_RUN: workflow });
    const complete = await request(done.env, 'POST', '/api/runner/jobs/job_run_d1_done_build/complete', {
      token: runner,
      headers,
      body: { status: 'completed', checkResults: s01.checks, expectedLineageEvents: 27 },
    });
    expect(complete.status).toBe(200);
    expect(done.counter.statements).toBe(2);
    expect(sent).toHaveLength(1);
  });

  it('every workflow step stays within 5', async () => {
    const prev = 'run_d1_wf_prev';
    const runId = 'run_d1_wf';
    await insertRun(baseEnv.DB, { runId: prev, target: 'duckdb', seed: 101, scenario: null });
    await upsertLineageGraph(baseEnv.DB, prev, buildLineageGraph(s01.events, s01.relations));
    await finishRun(baseEnv.DB, prev, 'passed', { pass: 40, fail: 0, error: 0, skip: 0 });
    await insertRun(baseEnv.DB, { runId, target: 'duckdb', seed: 101, scenario: 'S01' });
    await upsertCheckResults(baseEnv.DB, runId, s01.checks as CheckResult[]);
    await upsertLineageGraph(baseEnv.DB, runId, buildLineageGraph(s01.events, s01.relations));
    await baseEnv.DB.batch(lineageBundleStatements(baseEnv.DB, runId, [], [{ eventId: 'e0', r2Key: 'k' }]));
    await baseEnv.ARTIFACTS.put(`runs/${runId}/relations.json`, JSON.stringify(s01.relations));

    const steps: Array<[string, (e: AppEnv) => Promise<unknown>, number]> = [
      ['register-run', (e) => markRunRunning(e.DB, runId, runId), 1],
      [
        'enqueue-build',
        (e) =>
          insertJob(e.DB, { jobId: `job_${runId}_x`, runId, kind: 'dbt_build', payload: {}, workflowInstanceId: runId, eventType: 'build-complete' }),
        1,
      ],
      ['await-ingested', (e) => awaitIngested(e.DB, runId, { jobId: 'j', status: 'completed', checkCount: 40, expectedLineageEvents: 1 }), 2],
      ['summarize-run', (e) => summarizeRun(e.DB, runId), 1],
      ['finalize', (e) => finishRun(e.DB, runId, 'failed', { pass: 39, fail: 1, error: 0, skip: 0 }), 1],
      ['load-context', (e) => loadContext(e, { runId, incidentId: 'inc_d1', trigger: 'checks' }), 5],
      [
        'summarize-draft (Workers AI: reserve and settle)',
        async (e) => {
          const ai = { run: async () => ({ response: '{}', usage: { prompt_tokens: 900, completion_tokens: 200 } }) } as unknown as Ai;
          const ev = buildEvidence({ incidentId: 'inc_d1', runId, trigger: 'checks', checks: s01.checks, ranked: [], probeResults: [], relations: s01.relations });
          return summarizeAttempt(e, new WorkersAISummarizer(ai, '@cf/meta/llama-3.3-70b-instruct-fp8-fast', 'datatrust'), ev, 1, null);
        },
        2,
      ],
      [
        'persist-incident',
        (e) =>
          persistIncidentRows(e.DB, {
            incidentId: 'inc_d1',
            runId,
            trigger: 'checks',
            status: 'open',
            failingChecks: [],
            ranked: [],
            evidenceR2Key: null,
            summaryDraft: null,
            summary: null,
            summaryProvider: 'template',
            summaryModel: 'template-v1',
            summaryAttempts: 1,
            summaryFallback: false,
            summaryFallbackReason: null,
            provenance: {},
          }),
        2,
      ],
    ];
    for (const [name, fn, expected] of steps) {
      const { env, counter } = counted();
      await fn(env);
      expect(counter.statements, name).toBe(expected);
      expect(counter.statements, name).toBeLessThanOrEqual(5);
    }
    // load-context still returns the same graph and finds the baseline of the earlier passed run.
    const { env } = counted();
    const ctx = await loadContext(env, { runId, incidentId: 'inc_d1', trigger: 'checks' });
    expect(ctx.graph).toEqual(buildLineageGraph(s01.events, s01.relations));
    expect(ctx.baseline).not.toBeNull();
    expect(ctx.lastGreen?.runId).toBe(prev);
  });
});
