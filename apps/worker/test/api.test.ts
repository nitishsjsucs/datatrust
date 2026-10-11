import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env as baseEnv } from 'cloudflare:workers';
import { buildLineageGraph } from '@datatrust/rca';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import type { AppEnv } from '../src/env';
import { insertRun, upsertLineageGraph } from '../src/store/repo';
import { seed101Events, seed101Relations } from './helpers/fixtures';
import { humanClaims, type Keys, makeKeys, mint, OPERATOR, testEnv } from './helpers/keys';

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
