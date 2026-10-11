import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test';
import { env as baseEnv } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { exportSettled, LAKE_EXPORT_MAX_OBJECTS, settleSeconds } from '../src/api/lake';
import type { AppEnv } from '../src/env';
import { ulid } from '../src/ids';
import worker from '../src/index';
import { QUEUES } from '../src/queues/router';
import {
  AUDIT_MESSAGE_MAX_EVENTS,
  type AuditEvent,
  auditEvent,
  auditEventId,
  type AuditMessage,
  createSink,
  QueueSink,
  schemaProblems,
  STREAM_FIELDS,
} from '../src/sinks/event-sink';
import { request } from './helpers/app';
import { s01 } from './helpers/fixtures';
import { humanClaims, makeKeys, mint, OPERATOR, serviceClaims, testEnv } from './helpers/keys';

const env = baseEnv as unknown as AppEnv;

/** A stand-in producer that records what would be sent to datatrust-audit-events. */
function recordingQueue() {
  const messages: AuditMessage[] = [];
  const queue = {
    send: async (body: AuditMessage) => void messages.push(body),
    sendBatch: async (batch: Iterable<MessageSendRequest<AuditMessage>>) => {
      for (const m of batch) messages.push(m.body);
    },
  } as unknown as Queue;
  return { queue, messages };
}

async function deliver(queue: string, bodies: unknown[], e: AppEnv = env) {
  const batch = createMessageBatch(
    queue,
    bodies.map((body, i) => ({ id: `m${i}`, timestamp: new Date(), attempts: 1, body })),
  );
  await worker.queue(batch, e);
  return getQueueResult(batch, createExecutionContext());
}

const lakeEvent = (runId: string, checkId: string) =>
  auditEvent(env, 'check_result', runId, { event_id: auditEventId.checkResult(runId, checkId), check_id: checkId, status: 'pass' });

async function putLakeObject(timeMs: number, events: AuditEvent[], pad = 0): Promise<string> {
  const key = `lake/${new Date(timeMs).toISOString().slice(0, 10)}/${ulid(timeMs)}.ndjson`;
  const text = events.map((e) => JSON.stringify(e)).join('\n') + '\n' + (pad ? ' '.repeat(pad) + '\n' : '');
  await env.ARTIFACTS.put(key, text);
  return key;
}

describe('audit events match the lake schema', () => {
  it('declares the fields the lake expects', () => {
    expect(STREAM_FIELDS.map((f) => `${f.name}:${f.type}`)).toEqual([
      'event_id:string',
      'event_type:string',
      'environment:string',
      'run_id:string',
      'occurred_at:timestamp',
      'check_id:string',
      'status:string',
      'node:string',
      'payload:json',
    ]);
  });

  it('builds events with a deterministic id, an RFC 3339 occurred_at and an object payload', () => {
    const e = auditEvent(env, 'run_completed', 'run_1', {
      event_id: auditEventId.runCompleted('run_1'),
      status: 'passed',
      payload: { pass: 40 },
    });
    expect(schemaProblems(e as unknown as Record<string, unknown>)).toEqual([]);
    expect(e.event_id).toBe('evt_run_1_run_completed');
    expect(e.occurred_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(e.environment).toBe('local');
    expect(auditEventId.checkResult('run_1', 'U01')).toBe('evt_run_1_check_U01');
    expect(auditEventId.incidentCreated('inc_run_1_checks_00000000')).toBe('evt_inc_run_1_checks_00000000_created');
  });

  it('flags records the lake could not store', () => {
    const bad = { ...lakeEvent('r', 'U01'), occurred_at: '1760000000', payload: [1, 2] } as unknown as Record<string, unknown>;
    expect(schemaProblems(bad)).toEqual(['occurred_at must be an RFC 3339 timestamp', 'payload must be a JSON object']);
    expect(schemaProblems({ ...bad, extra: 1 })).toContain('unknown field extra');
  });
});

describe('QueueSink', () => {
  it('is the sink in every environment and sends to datatrust-audit-events', () => {
    expect(createSink(env)).toBeInstanceOf(QueueSink);
    expect(createSink({ ...env, ENVIRONMENT: 'production' }).kind).toBe('queue');
  });

  it('validates before sending and splits into messages of at most 50 events under 64 KB', async () => {
    const { queue, messages } = recordingQueue();
    const sink = new QueueSink(queue);
    await sink.send([lakeEvent('run_one', 'U01')]);
    expect(messages).toHaveLength(1);
    const many = Array.from({ length: 120 }, (_, i) => lakeEvent('run_many', `C${i}`));
    await sink.send(many);
    const batch = messages.slice(1);
    expect(batch.map((m) => m.events.length)).toEqual([50, 50, 20]);
    for (const m of batch) expect(JSON.stringify(m).length).toBeLessThan(64 * 1024);
    expect(batch.flatMap((m) => m.events.map((e) => e.event_id))).toEqual(many.map((e) => e.event_id));
    const invalid = { ...lakeEvent('run_bad', 'U01'), payload: 'text' } as unknown as AuditEvent;
    await expect(sink.send([invalid])).rejects.toThrow(/payload must be a JSON object/);
    expect(messages).toHaveLength(4);
  });

  it('sends one message per check-results delivery, with the same event ids on redelivery', async () => {
    const { queue, messages } = recordingQueue();
    const e = { ...env, AUDIT_Q: queue };
    const body = { runId: 'run_sink', checkResults: s01.checks };
    await deliver(QUEUES.checkResults, [body], e);
    await deliver(QUEUES.checkResults, [body], e);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.events).toHaveLength(40);
    expect(messages[0]!.events.length).toBeLessThanOrEqual(AUDIT_MESSAGE_MAX_EVENTS);
    expect(messages[0]!.events.every((ev) => ev.event_type === 'check_result' && schemaProblems(ev as never).length === 0)).toBe(true);
    expect(messages[1]!.events.map((ev) => ev.event_id)).toEqual(messages[0]!.events.map((ev) => ev.event_id));
    expect(messages[0]!.events[0]!.event_id).toBe(`evt_run_sink_check_${s01.checks[0]!.checkId}`);
  });
});

describe('datatrust-audit-events consumer', () => {
  it('writes the whole batch as one new immutable lake object and acks malformed messages', async () => {
    const before = new Set((await env.ARTIFACTS.list({ prefix: 'lake/' })).objects.map((o) => o.key));
    const a = { events: [lakeEvent('run_audit', 'U01'), lakeEvent('run_audit', 'U02')] };
    const b = { events: [lakeEvent('run_audit', 'U03')] };
    const result = await deliver(QUEUES.auditEvents, [a, { events: [{ nope: 1 }] }, b]);
    expect(result.explicitAcks.sort()).toEqual(['m0', 'm1', 'm2']);
    expect(result.retryMessages).toEqual([]);
    const written = (await env.ARTIFACTS.list({ prefix: 'lake/' })).objects.filter((o) => !before.has(o.key));
    expect(written).toHaveLength(1);
    expect(written[0]!.key).toMatch(/^lake\/\d{4}-\d{2}-\d{2}\/[0-9A-Z]{26}\.ndjson$/);
    const lines = (await (await env.ARTIFACTS.get(written[0]!.key))!.text()).trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.check_id)).toEqual(['U01', 'U02', 'U03']);

    // A redelivery writes a second object (never an overwrite) with the same event ids.
    await deliver(QUEUES.auditEvents, [a, b]);
    const again = (await env.ARTIFACTS.list({ prefix: 'lake/' })).objects.filter((o) => !before.has(o.key));
    expect(again).toHaveLength(2);
    const second = again.find((o) => o.key !== written[0]!.key)!;
    const ids = (await (await env.ARTIFACTS.get(second.key))!.text()).trim().split('\n').map((l) => JSON.parse(l).event_id);
    expect(ids).toEqual(lines.map((l) => l.event_id));
  });
});

describe('/api/lake/export', () => {
  it('returns settled objects only, oldest first, and stops at the first unsettled one', async () => {
    const t0 = Date.UTC(2003, 0, 1);
    const a = await putLakeObject(t0, [lakeEvent('run_2003', 'A')]);
    const b = await putLakeObject(t0 + 2_000, [lakeEvent('run_2003', 'B')]);
    const out = await exportSettled(env.ARTIFACTS, { after: 'lake/2003-', nowMs: t0 + 121_000, settleMs: 120_000 });
    expect(out.keys).toEqual([a]);
    expect(out.nextAfter).toBe(a);
    expect(out.more).toBe(false);
    expect(JSON.parse(out.body.trim()).check_id).toBe('A');
    const later = await exportSettled(env.ARTIFACTS, { after: a, nowMs: t0 + 123_000, settleMs: 120_000 });
    expect(later.keys).toEqual([b]);
  });

  it('returns at most 100 objects per call and resumes from the cursor', async () => {
    const t0 = Date.UTC(2001, 0, 1);
    const keys: string[] = [];
    for (let i = 0; i < LAKE_EXPORT_MAX_OBJECTS + 5; i++) keys.push(await putLakeObject(t0 + i * 1000, [lakeEvent('run_2001', `C${i}`)]));
    const opts = { nowMs: Date.UTC(2001, 0, 2), settleMs: 120_000 };
    const first = await exportSettled(env.ARTIFACTS, { after: 'lake/2001-', ...opts });
    expect(first.keys).toEqual(keys.slice(0, 100));
    expect(first.more).toBe(true);
    const second = await exportSettled(env.ARTIFACTS, { after: first.nextAfter, ...opts });
    expect(second.keys).toEqual(keys.slice(100));
    expect(second.more).toBe(false);
  });

  it('returns at most 1 MB of NDJSON per call', async () => {
    const t0 = Date.UTC(2002, 0, 1);
    const keys = [];
    for (let i = 0; i < 3; i++) keys.push(await putLakeObject(t0 + i * 1000, [lakeEvent('run_2002', `S${i}`)], 400_000));
    const out = await exportSettled(env.ARTIFACTS, { after: 'lake/2002-', nowMs: Date.UTC(2002, 0, 2), settleMs: 120_000 });
    expect(out.keys).toEqual(keys.slice(0, 2));
    expect(out.more).toBe(true);
    expect(out.body.length).toBeLessThanOrEqual(1_000_000);
  });

  it('serves the runner role only, and the old local-only route is gone', async () => {
    const keys = await makeKeys();
    const local = testEnv(keys);
    const runner = await mint(keys, serviceClaims());
    const res = await request(local, 'GET', `/api/lake/export?after=${encodeURIComponent('lake/2003-')}`, { token: runner });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
    expect(Number(res.headers.get('x-objects'))).toBeGreaterThanOrEqual(2);
    expect(res.headers.get('x-next-after')! > 'lake/2003-').toBe(true);
    const operator = await mint(keys, humanClaims(OPERATOR));
    expect((await request(local, 'GET', '/api/lake/export', { token: operator })).status).toBe(403);
    expect((await request(local, 'GET', '/api/dev/lake-export', { token: runner })).status).toBe(404);
    expect(settleSeconds(undefined)).toBe(120);
    expect(settleSeconds('5')).toBe(5);
    expect(settleSeconds('nonsense')).toBe(120);
  });
});
