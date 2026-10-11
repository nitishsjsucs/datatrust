import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test';
import { env as baseEnv } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../src/env';
import worker from '../src/index';
import {
  type AuditEvent,
  auditEvent,
  createSink,
  PipelinesSink,
  R2NdjsonSink,
  schemaProblems,
  STREAM_FIELDS,
} from '../src/sinks/event-sink';
import { request } from './helpers/app';
import { s01 } from './helpers/fixtures';
import { makeKeys, mint, serviceClaims, testEnv } from './helpers/keys';

const env = baseEnv as unknown as AppEnv;

describe('audit events match the Basin Pipelines stream schema', () => {
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

  it('builds events with an RFC 3339 occurred_at and an object payload', () => {
    const e = auditEvent(env, 'run_completed', 'run_1', { status: 'passed', payload: { pass: 40 } });
    expect(schemaProblems(e as unknown as Record<string, unknown>)).toEqual([]);
    expect(e.occurred_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(e.environment).toBe('local');
  });

  it('flags records Pipelines would silently drop', () => {
    const bad = { ...auditEvent(env, 'run_completed', 'r'), occurred_at: '1760000000', payload: [1, 2] } as unknown as Record<string, unknown>;
    expect(schemaProblems(bad)).toEqual(['occurred_at must be an RFC 3339 timestamp', 'payload must be a JSON object']);
    expect(schemaProblems({ ...bad, extra: 1 })).toContain('unknown field extra');
  });
});

describe('sinks', () => {
  it('uses the Pipelines binding when present and validates before sending', async () => {
    const sent: AuditEvent[][] = [];
    const sink = createSink({ ...env, EVENTS: { send: async (e: object[]) => void sent.push(e as AuditEvent[]) } });
    expect(sink).toBeInstanceOf(PipelinesSink);
    await sink.send([auditEvent(env, 'check_result', 'run_p', { check_id: 'U01', status: 'pass' })]);
    expect(sent[0]![0]!.check_id).toBe('U01');
    const invalid = { ...auditEvent(env, 'check_result', 'run_p'), payload: 'text' } as unknown as AuditEvent;
    await expect(sink.send([invalid])).rejects.toThrow(/payload must be a JSON object/);
  });

  it('writes NDJSON to the local R2 bucket otherwise', async () => {
    const sink = createSink(env);
    expect(sink).toBeInstanceOf(R2NdjsonSink);
    await sink.send([auditEvent(env, 'run_completed', 'run_r2', { status: 'failed' })]);
    const list = await env.ARTIFACTS.list({ prefix: 'lake/' });
    const text = await (await env.ARTIFACTS.get(list.objects.at(-1)!.key))!.text();
    expect(JSON.parse(text.trim()).run_id).toBe('run_r2');
  });

  it('emits one check_result event per check from the dt-check-results consumer', async () => {
    const before = (await env.ARTIFACTS.list({ prefix: 'lake/' })).objects.length;
    const batch = createMessageBatch('dt-check-results', [
      { id: 'm0', timestamp: new Date(), attempts: 1, body: { runId: 'run_sink', checkResults: s01.checks.slice(0, 20) } },
    ]);
    await worker.queue(batch, env);
    await getQueueResult(batch, createExecutionContext());
    const objects = (await env.ARTIFACTS.list({ prefix: 'lake/' })).objects;
    expect(objects.length).toBe(before + 1);
    const lines = (await (await env.ARTIFACTS.get(objects.at(-1)!.key))!.text()).trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(20);
    expect(lines.every((l) => l.event_type === 'check_result' && l.run_id === 'run_sink')).toBe(true);
    expect(lines.every((l) => schemaProblems(l).length === 0)).toBe(true);
  });
});

describe('/api/dev/lake-export', () => {
  it('returns NDJSON after a cursor, for the runner, only locally', async () => {
    const keys = await makeKeys();
    const local = testEnv(keys);
    const token = await mint(keys, serviceClaims());
    const all = await request(local, 'GET', '/api/dev/lake-export', { token });
    expect(all.status).toBe(200);
    const next = all.headers.get('x-next-after')!;
    expect(next).toMatch(/^lake\//);
    expect((await all.text()).trim().split('\n').length).toBeGreaterThan(0);
    const after = await request(local, 'GET', `/api/dev/lake-export?after=${encodeURIComponent(next)}`, { token });
    expect(await after.text()).toBe('');
    const prod: AppEnv = {
      ...local,
      ENVIRONMENT: 'production',
      ACCESS_MODE: 'cloudflare',
      SUMMARIZER: 'workers-ai',
      AI: {} as Ai,
      EVENTS: { send: async () => {} },
    };
    // In production the route does not exist (and without a reachable team JWKS the request is 401 first).
    expect([401, 404]).toContain((await request(prod, 'GET', '/api/dev/lake-export', { token })).status);
  });
});
