import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env as baseEnv } from 'cloudflare:workers';
import { buildLineageGraph } from '@datatrust/rca';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import type { AppEnv } from '../src/env';
import { insertRun, upsertIncident, upsertLineageGraph } from '../src/store/repo';
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
    // `warm` says whether src/index.ts's start-up warm-up had settled (free-plan.test.ts checks it turns true).
    expect(await res.json()).toEqual({ ok: true, environment: 'local', version: '0.1.0', warm: expect.any(Boolean) });
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

  it('lists incidents with the top candidate read by D1, not by parsing ranked_json', async () => {
    await upsertIncident(baseEnv.DB, {
      incidentId: 'inc_api_1',
      runId: 'run_api_1',
      trigger: 'checks',
      status: 'open',
      failingChecks: [],
      ranked: [{ node: 'source.datatrust.raw.hires', score: 0.9 }, { node: 'model.datatrust.stg_hires', score: 0.5 }] as never,
      evidenceR2Key: null,
      summaryDraft: null,
      summary: null,
      summaryProvider: 'template',
      summaryModel: 'template-v1',
      summaryAttempts: 1,
      summaryFallback: false,
      summaryFallbackReason: null,
      provenance: {},
    });
    const list = (await (await get('/api/incidents?runId=run_api_1')).json()) as { incidents: Array<Record<string, unknown>> };
    expect(list.incidents).toEqual([
      {
        incidentId: 'inc_api_1',
        runId: 'run_api_1',
        trigger: 'checks',
        status: 'open',
        createdAt: expect.any(String),
        topCandidate: 'source.datatrust.raw.hires',
        summaryProvider: 'template',
        summaryFallback: false,
      },
    ]);
    // The single-incident fallback (no R2 object) still names the top candidate.
    const one = (await (await get('/api/incidents/inc_api_1')).json()) as Record<string, unknown>;
    expect(one['topCandidate']).toBe('source.datatrust.raw.hires');
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

describe('cross-site request forgery guard on state-changing routes', () => {
  /** A raw POST with the operator's verified token, as a browser form would arrive through Access. */
  async function post(path: string, body: string, headers: Record<string, string>): Promise<Response> {
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request(`http://worker${path}`, { method: 'POST', headers: { 'Cf-Access-Jwt-Assertion': token, ...headers }, body }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return res;
  }

  it('answers 415 to a form-encodable body (text/plain, urlencoded, multipart) before any handler runs', async () => {
    // An HTML form with enctype=text/plain can produce exactly this JSON text; hono's c.req.json() would parse it.
    const prune = '{"olderThanDays":7,"maxRuns":5,"pad":"="}';
    const run = '{"target":"bigquery","scenario":"S01","pad":"="}';
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      expect((await post('/api/admin/prune', prune, { 'content-type': type })).status).toBe(415);
      expect((await post('/api/runs', run, { 'content-type': type })).status).toBe(415);
    }
    expect((await post('/api/runs', run, {})).status).toBe(415);
    const runs = await baseEnv.DB.prepare(`SELECT count(*) AS n FROM runs WHERE target = 'bigquery'`).first<{ n: number }>();
    expect(runs?.n).toBe(0);
  });

  it('answers 403 to a request the browser marks cross-site, even with a JSON content type', async () => {
    const res = await post('/api/admin/prune', '{"dryRun":true}', { 'content-type': 'application/json', 'Sec-Fetch-Site': 'cross-site' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'cross_site' });
  });

  it('accepts JSON from the CLI, the runner and same-origin pages, and leaves GET alone', async () => {
    const ok = await post('/api/admin/prune', '{"dryRun":true}', { 'content-type': 'application/json; charset=utf-8', 'Sec-Fetch-Site': 'same-origin' });
    expect(ok.status).toBe(200);
    expect((await get('/api/incidents')).status).toBe(200);
  });
});
