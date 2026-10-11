import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env as baseEnv } from 'cloudflare:workers';
import { buildLineageGraph } from '@datatrust/rca';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import type { AppEnv } from '../src/env';
import { insertRun, upsertLineageGraph } from '../src/store/repo';
import { s01, seed101Events, seed101Relations } from './helpers/fixtures';
import { request } from './helpers/app';
import { leasedBuildJob, manyEvents, recordingQueue } from './helpers/jobs';
import { humanClaims, type Keys, makeKeys, mint, OPERATOR, serviceClaims, testEnv } from './helpers/keys';

const app = createApp();
let keys: Keys;
let env: AppEnv;
let token: string;

async function get(path: string): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`http://worker${path}`, { headers: { 'Cf-Access-Jwt-Assertion': token } }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

beforeAll(async () => {
  keys = await makeKeys();
  env = testEnv(keys);
  token = await mint(keys, humanClaims(OPERATOR));
});

describe('read API', () => {
  it('serves /healthz without auth and without data', async () => {
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request('http://worker/healthz'), env, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, environment: 'local', version: '0.1.0' });
  });

  it('returns 404 for an unknown run and an unknown route', async () => {
    expect((await get('/api/runs/run_missing')).status).toBe(404);
    expect((await get('/api/nope')).status).toBe(404);
  });

  it('returns a queued run with zero check counts', async () => {
    await insertRun(baseEnv.DB, { runId: 'run_api_1', target: 'duckdb', seed: 101, scenario: null });
    const res = await get('/api/runs/run_api_1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['status']).toBe('queued');
    expect(body['checkCounts']).toEqual({ pass: 0, fail: 0, error: 0, skip: 0 });
  });

  it('lists incidents (none yet)', async () => {
    const res = await get('/api/incidents?runId=run_api_1');
    expect(await res.json()).toEqual({ incidents: [] });
  });

  it('serves the upstream column-lineage subgraph of a failed metric from D1', async () => {
    const g = buildLineageGraph(seed101Events, seed101Relations);
    await upsertLineageGraph(baseEnv.DB, 'run_api_1', g);
    const res = await get(
      '/api/lineage/run_api_1/upstream?node=model.datatrust.fct_compensation_usd&column=base_salary_usd',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nodes: Array<{ node: string; distance: number }> };
    const nodes = body.nodes.map((n) => n.node);
    expect(nodes[0]).toBe('model.datatrust.fct_compensation_usd');
    expect(nodes).toContain('source.datatrust.raw.compensation');
    expect(nodes).toContain('source.datatrust.raw.fx_rates');
    expect(nodes).not.toContain('model.datatrust.stg_employees');
    expect((await get('/api/lineage/run_api_1/upstream')).status).toBe(400);
  });
});

describe('POST /api/v1/lineage limits (Free plan, SPEC 28.5.2)', () => {
  it('accepts up to 10 events in one POST with one queue message, and answers 413 above 10 events or 256 KB', async () => {
    const runner = await mint(keys, serviceClaims());
    const headers = await leasedBuildJob('run_api_ol');
    const { queue, bodies } = recordingQueue<{ runId: string; events: unknown[] }>();
    const e = { ...env, LINEAGE_Q: queue };
    const ten = manyEvents(seed101Events, 10);
    const ok = await request(e, 'POST', '/api/v1/lineage', { token: runner, headers, body: ten });
    expect(ok.status).toBe(202);
    expect(((await ok.json()) as { accepted: number }).accepted).toBe(10);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.events).toHaveLength(10);
    const eleven = await request(e, 'POST', '/api/v1/lineage', { token: runner, headers, body: manyEvents(seed101Events, 11) });
    expect(eleven.status).toBe(413);
    const padded = [{ ...(seed101Events[0] as object), padding: 'x'.repeat(270_000) }];
    const big = await request(e, 'POST', '/api/v1/lineage', { token: runner, headers, body: padded });
    expect(big.status).toBe(413);
    expect(bodies).toHaveLength(1);
    const operator = await mint(keys, humanClaims(OPERATOR));
    expect((await request(e, 'POST', '/api/v1/lineage', { token: operator, headers, body: ten })).status).toBe(403);
  });
});

describe('completion request caps (Free plan CPU, SPEC 28.5.3)', () => {
  it('answers 400 to more than 100 check results or probe results', async () => {
    const runner = await mint(keys, serviceClaims());
    const headers = await leasedBuildJob('run_api_caps');
    const path = '/api/runner/jobs/job_run_api_caps_build/complete';
    const checks = Array.from({ length: 101 }, (_, i) => ({ ...s01.checks[i % 40]!, checkId: `C${i}` }));
    const probes = Array.from({ length: 101 }, (_, i) => ({ ...s01.probeResults[i % s01.probeResults.length]!, probeId: `p${i}` }));
    expect((await request(env, 'POST', path, { token: runner, headers, body: { status: 'completed', checkResults: checks } })).status).toBe(400);
    expect((await request(env, 'POST', path, { token: runner, headers, body: { status: 'completed', probeResults: probes } })).status).toBe(400);
  });
});
