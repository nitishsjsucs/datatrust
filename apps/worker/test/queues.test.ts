import { createExecutionContext, createMessageBatch, getQueueResult, introspectWorkflowInstance } from 'cloudflare:test';
import { env as baseEnv } from 'cloudflare:workers';
import { buildLineageGraph } from '@datatrust/rca';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import type { AppEnv } from '../src/env';
import { investigationIds } from '../src/investigation-ids';
import {
  countCheckResults,
  countLineageEvents,
  insertRun,
  listCheckResults,
  loadLineageGraph,
  upsertLineageGraph,
} from '../src/store/repo';
import { request } from './helpers/app';
import { s01 } from './helpers/fixtures';
import { leasedBuildJob, manyEvents, recordingQueue } from './helpers/jobs';
import { makeKeys, mint, serviceClaims, testEnv } from './helpers/keys';

const env = baseEnv as unknown as AppEnv;

async function deliver(queue: string, bodies: unknown[]) {
  const batch = createMessageBatch(
    queue,
    bodies.map((body, i) => ({ id: `m${i}`, timestamp: new Date(), attempts: 1, body })),
  );
  const ctx = createExecutionContext();
  await worker.queue(batch, env);
  return getQueueResult(batch, ctx);
}

describe('datatrust-check-results', () => {
  it('upserts check results idempotently and acks', async () => {
    await insertRun(env.DB, { runId: 'run_q1', target: 'duckdb', seed: 101, scenario: null });
    const chunks = [s01.checks.slice(0, 20), s01.checks.slice(20)];
    const result = await deliver(
      'datatrust-check-results',
      chunks.map((c) => ({ runId: 'run_q1', checkResults: c })),
    );
    expect(result.explicitAcks).toEqual(['m0', 'm1']);
    expect(await countCheckResults(env.DB, 'run_q1')).toBe(40);
    await deliver('datatrust-check-results', [{ runId: 'run_q1', checkResults: s01.checks.slice(0, 5) }]);
    expect(await countCheckResults(env.DB, 'run_q1')).toBe(40);
    const failing = (await listCheckResults(env.DB, 'run_q1')).filter((c) => c.status === 'fail');
    expect(failing.map((c) => c.checkId)).toEqual(['U05']);
  });

  it('acks malformed messages without retrying', async () => {
    const result = await deliver('datatrust-check-results', [{ nope: true }]);
    expect(result.explicitAcks).toEqual(['m0']);
    expect(result.retryMessages).toEqual([]);
  });
});

describe('datatrust-lineage-events', () => {
  async function storeBundles(runId: string, size = 10) {
    await env.ARTIFACTS.put(`runs/${runId}/relations.json`, JSON.stringify(s01.relations));
    await upsertLineageGraph(env.DB, runId, buildLineageGraph([], s01.relations));
    const refs = [];
    for (const [i, ev] of s01.events.entries()) {
      const key = `lineage/${runId}/e${i}.json`;
      await env.ARTIFACTS.put(key, JSON.stringify(ev));
      refs.push({ eventId: `e${i}`, r2Key: key });
    }
    const bundles = [];
    for (let i = 0; i < refs.length; i += size) bundles.push({ runId, events: refs.slice(i, i + size) });
    return bundles;
  }

  it('turns bundles of OpenLineage events in R2 into column and dataset edges in D1', async () => {
    const runId = 'run_q2';
    const bundles = await storeBundles(runId);
    expect(bundles).toHaveLength(Math.ceil(s01.events.length / 10));
    for (const b of bundles) {
      const result = await deliver('datatrust-lineage-events', [b]);
      expect(result.retryMessages).toEqual([]);
      expect(result.explicitAcks).toEqual(['m0']);
    }
    expect(await countLineageEvents(env.DB, runId)).toBe(s01.events.length);
    expect(await loadLineageGraph(env.DB, runId)).toEqual(buildLineageGraph(s01.events, s01.relations));
    // A redelivered bundle adds nothing.
    await deliver('datatrust-lineage-events', [bundles[0]]);
    expect(await countLineageEvents(env.DB, runId)).toBe(s01.events.length);
    expect(await loadLineageGraph(env.DB, runId)).toEqual(buildLineageGraph(s01.events, s01.relations));
  });

  it('carries 140 events posted 10 at a time in exactly 14 messages, and ingests all of them', async () => {
    const runId = 'run_q140';
    const keys = await makeKeys();
    const runner = await mint(keys, serviceClaims());
    const headers = await leasedBuildJob(runId);
    await env.ARTIFACTS.put(`runs/${runId}/relations.json`, JSON.stringify(s01.relations));
    await upsertLineageGraph(env.DB, runId, buildLineageGraph([], s01.relations));
    const { queue, bodies } = recordingQueue();
    const e = { ...testEnv(keys), LINEAGE_Q: queue };
    const events = manyEvents(s01.events, 140);
    for (let i = 0; i < events.length; i += 10) {
      const res = await request(e, 'POST', '/api/v1/lineage', { token: runner, headers, body: events.slice(i, i + 10) });
      expect(res.status).toBe(202);
    }
    expect(bodies).toHaveLength(14);
    for (const b of bodies) expect(await deliver('datatrust-lineage-events', [b])).toMatchObject({ retryMessages: [] });
    expect(await countLineageEvents(env.DB, runId)).toBe(140);
    expect(await loadLineageGraph(env.DB, runId)).toEqual(buildLineageGraph(s01.events, s01.relations));
  });

  it('retries while relations.json is not uploaded yet, and acks a malformed or oversized bundle', async () => {
    const result = await deliver('datatrust-lineage-events', [{ runId: 'run_q3', events: [{ eventId: 'e0', r2Key: 'lineage/run_q3/e0.json' }] }]);
    expect(result.retryMessages.map((m) => m.msgId)).toEqual(['m0']);
    expect(await countLineageEvents(env.DB, 'run_q3')).toBe(0);
    const eleven = Array.from({ length: 11 }, (_, i) => ({ eventId: `e${i}`, r2Key: `lineage/run_q3/e${i}.json` }));
    const bad = await deliver('datatrust-lineage-events', [{ runId: 'run_q3', eventId: 'e0', r2Key: 'x' }, { runId: 'run_q3', events: eleven }]);
    expect(bad.explicitAcks).toEqual(['m0', 'm1']);
    expect(bad.retryMessages).toEqual([]);
  });
});

describe('datatrust-investigate', () => {
  it('creates one InvestigationWorkflow per (run, trigger, alert) and acks a redelivery', async () => {
    const runId = 'run_q4';
    const ids = await investigationIds(runId, 'checks');
    expect(ids.instanceId).toBe('inv_run_q4_checks_00000000');
    await using instance = await introspectWorkflowInstance(env.INVESTIGATION, ids.instanceId);
    await instance.modify(async (m) => {
      await m.mockStepError({ name: 'load-context' }, new Error('stop here'));
      await m.disableRetryDelays();
    });
    const msg = { runId, incidentId: ids.incidentId, trigger: 'checks' };
    const first = await deliver('datatrust-investigate', [msg]);
    expect(first.explicitAcks).toEqual(['m0']);
    const again = await deliver('datatrust-investigate', [msg]);
    expect(again.explicitAcks).toEqual(['m0']);
    expect(again.retryMessages).toEqual([]);
    await instance.waitForStatus('errored');
  });

  it('gives an alert its own id derived from the alert body, at most 50 characters', async () => {
    const runId = 'run_01J9ZZZZZZZZZZZZZZZZZZZZZZ';
    const alert = { runId, metricNode: 'model.datatrust.metric_headcount_monthly', observed: 900, expected: 870 };
    const a = await investigationIds(runId, 'alert', alert);
    const b = await investigationIds(runId, 'alert', { ...alert, observed: 901 });
    const c = await investigationIds(runId, 'checks');
    expect(a.instanceId).toMatch(/^inv_run_01J9Z+_alert_[0-9a-f]{8}$/);
    expect(a.instanceId).not.toBe(b.instanceId);
    expect(c.instanceId.length).toBeLessThanOrEqual(50);
    expect(c.instanceId).toMatch(/^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/);
  });
});

describe('datatrust-dlq', () => {
  it('records dead letters in D1', async () => {
    const result = await deliver('datatrust-dlq', [{ runId: 'x', poison: true }]);
    expect(result.explicitAcks).toEqual(['m0']);
    const row = await env.DB.prepare('SELECT queue, body_json FROM dead_letters').first<{ queue: string; body_json: string }>();
    expect(row?.queue).toBe('datatrust-dlq');
    expect(JSON.parse(row!.body_json)).toEqual({ runId: 'x', poison: true });
  });
});
