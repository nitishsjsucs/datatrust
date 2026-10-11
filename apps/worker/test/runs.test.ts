/**
 * POST /api/runs: BigQuery runs go one at a time (every one builds the same datatrust_* datasets, so a second
 * build would change the tables the first run's diagnostics probe), and a run whose workflow cannot be
 * created is closed as 'error' instead of staying 'queued'.
 */
import { env as baseEnv } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AppEnv } from '../src/env';
import { finishRun, getRun, insertJob, setRunIncident } from '../src/store/repo';
import { request } from './helpers/app';
import { humanClaims, type Keys, makeKeys, mint, OPERATOR, testEnv } from './helpers/keys';

let keys: Keys;
let operator: string;
const created: string[] = [];
const stub = { create: async (o: { id: string }) => void created.push(o.id) } as unknown as Workflow;
let env: AppEnv;

beforeAll(async () => {
  keys = await makeKeys();
  operator = await mint(keys, humanClaims(OPERATOR));
  env = testEnv(keys, { VALIDATION_RUN: stub });
});

async function start(target: 'bigquery' | 'duckdb', e = env) {
  const res = await request(e, 'POST', '/api/runs', { token: operator, body: { target, seed: 101, scenario: 'S01' } });
  return { status: res.status, body: (await res.json()) as { runId: string | null; error?: string; status?: string } };
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

describe('one BigQuery run at a time', () => {
  it('refuses a second BigQuery run while the first is in flight, and never blocks local runs', async () => {
    const first = await start('bigquery');
    expect(first.status).toBe(201);
    const second = await start('bigquery');
    expect(second.status).toBe(409);
    expect(second.body).toEqual({ error: 'bigquery_run_in_flight', runId: first.body.runId, status: 'queued' });
    expect((await start('duckdb')).status).toBe(201);
    expect(created).toHaveLength(2);

    // Failed, and its investigation has not written the incident yet: still in flight.
    await finishRun(baseEnv.DB, first.body.runId!, 'failed');
    expect((await start('bigquery')).status).toBe(409);
    await setRunIncident(baseEnv.DB, first.body.runId!, 'inc_x');
    const third = await start('bigquery');
    expect(third.status).toBe(201);
    await finishRun(baseEnv.DB, third.body.runId!, 'passed');
  });

  it('counts an open BigQuery diagnostics job (an alert investigation) as in flight', async () => {
    await insertJob(baseEnv.DB, {
      jobId: 'job_inc_alert_diag',
      runId: 'run_alerted',
      kind: 'diagnostics',
      payload: { runId: 'run_alerted', target: 'bigquery', probes: [] },
      workflowInstanceId: 'inv_alerted',
      eventType: 'diagnostics-complete',
    });
    const refused = await start('bigquery');
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ runId: 'run_alerted', status: 'investigating' });
    await baseEnv.DB.prepare(`UPDATE jobs SET status = 'completed' WHERE job_id = 'job_inc_alert_diag'`).run();
    const ok = await start('bigquery');
    expect(ok.status).toBe(201);
    await finishRun(baseEnv.DB, ok.body.runId!, 'passed');
  });

  it('stops counting a run whose workflow died after the in-flight bound', async () => {
    await baseEnv.DB.prepare(
      `INSERT INTO runs (run_id, target, seed, scenario, status, created_at) VALUES ('run_zombie', 'bigquery', 101, NULL, 'running', ?)`,
    )
      .bind(hoursAgo(9))
      .run();
    await baseEnv.DB.prepare(
      `INSERT INTO runs (run_id, target, seed, scenario, status, created_at, finished_at) VALUES ('run_no_incident', 'bigquery', 101, 'S01', 'failed', ?, ?)`,
    )
      .bind(hoursAgo(4), hoursAgo(3))
      .run();
    const ok = await start('bigquery');
    expect(ok.status).toBe(201);
    await finishRun(baseEnv.DB, ok.body.runId!, 'passed');
  });
});

describe('workflow creation failure', () => {
  it('closes the run as error and answers 500', async () => {
    const broken = { create: async () => Promise.reject(new Error('workflows unavailable')) } as unknown as Workflow;
    const res = await start('duckdb', testEnv(keys, { VALIDATION_RUN: broken }));
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('workflow_not_created');
    const run = await getRun(baseEnv.DB, res.body.runId!);
    expect(run?.status).toBe('error');
    expect(run?.finished_at).not.toBeNull();
  });
});
