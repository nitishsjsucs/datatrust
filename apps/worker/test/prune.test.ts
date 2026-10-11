/**
 * POST /api/admin/prune (SPEC risk 25): old runs lose their lineage detail (D1 edges, events and nodes, R2
 * `lineage/<runId>/`), everything else stays, the latest passed run is kept as the investigation baseline, and
 * one call stays inside the Free plan's per-invocation limits.
 */
import { env as baseEnv } from 'cloudflare:workers';
import { buildLineageGraph } from '@datatrust/rca';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AppEnv } from '../src/env';
import { baselineChecksums, lineageBundleStatements, prunableRuns, upsertLineageGraph } from '../src/store/repo';
import { request } from './helpers/app';
import { countingDb } from './helpers/counting-db';
import { s01 } from './helpers/fixtures';
import { humanClaims, type Keys, makeKeys, mint, OPERATOR, serviceClaims, testEnv, VIEWER } from './helpers/keys';

let keys: Keys;
let env: AppEnv;
let operator: string;

const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

/** A run with a full seed-101 lineage graph, two lineage event rows and objects, a check result and an incident. */
async function seedRun(runId: string, status: string, createdDaysAgo: number) {
  const db = baseEnv.DB;
  await db
    .prepare(`INSERT INTO runs (run_id, target, seed, scenario, status, created_at, finished_at) VALUES (?, 'duckdb', 101, NULL, ?, ?, ?)`)
    .bind(runId, status, ago(createdDaysAgo), status === 'running' ? null : ago(createdDaysAgo))
    .run();
  await upsertLineageGraph(db, runId, buildLineageGraph(s01.events, s01.relations));
  const events = [0, 1].map((i) => ({ eventId: `e${i}`, r2Key: `lineage/${runId}/e${i}.json` }));
  await db.batch(lineageBundleStatements(db, runId, [], events));
  for (const e of events) await baseEnv.ARTIFACTS.put(e.r2Key, '{}');
  await baseEnv.ARTIFACTS.put(`runs/${runId}/relations.json`, '{}');
  await db
    .prepare(
      `INSERT INTO check_results (run_id, check_id, test_name, category, status, failures, node, columns_json) VALUES (?, 'U05', 'dq_u05', 'uniqueness', 'fail', 3, 'model.datatrust.stg_hires', '[]')`,
    )
    .bind(runId)
    .run();
  await db
    .prepare(
      `INSERT INTO incidents (incident_id, run_id, trigger, status, failing_checks_json, ranked_json, provenance_json, created_at) VALUES (?, ?, 'checks', 'open', '[]', '[]', '{}', ?)`,
    )
    .bind(`inc_${runId}`, runId, ago(createdDaysAgo))
    .run();
}

async function counts(runId: string) {
  const n = (table: string) =>
    baseEnv.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE run_id = ?`).bind(runId).first<{ n: number }>().then((r) => r?.n ?? 0);
  return {
    edges: await n('lineage_edges'),
    events: await n('lineage_events'),
    nodes: await n('lineage_nodes'),
    checks: await n('check_results'),
    incidents: await n('incidents'),
    runs: await n('runs'),
    lineageObjects: (await baseEnv.ARTIFACTS.list({ prefix: `lineage/${runId}/` })).objects.length,
    runObjects: (await baseEnv.ARTIFACTS.list({ prefix: `runs/${runId}/` })).objects.length,
  };
}

beforeAll(async () => {
  keys = await makeKeys();
  env = testEnv(keys);
  operator = await mint(keys, humanClaims(OPERATOR));
  await seedRun('run_prune_old_failed', 'failed', 60);
  await seedRun('run_prune_old_passed', 'passed', 50);
  await seedRun('run_prune_latest_passed', 'passed', 40);
  await seedRun('run_prune_old_running', 'running', 45);
  await seedRun('run_prune_recent_failed', 'failed', 3);
});

describe('POST /api/admin/prune', () => {
  it('is for operators only', async () => {
    const viewer = await mint(keys, humanClaims(VIEWER));
    const runner = await mint(keys, serviceClaims());
    for (const token of [viewer, runner]) {
      expect((await request(env, 'POST', '/api/admin/prune', { token, body: {} })).status).toBe(403);
    }
    expect((await request(env, 'POST', '/api/admin/prune', { body: {} })).status).toBe(401);
    for (const body of [{ olderThanDays: 6 }, { maxRuns: 11 }, { maxRuns: 0 }]) {
      expect((await request(env, 'POST', '/api/admin/prune', { token: operator, body })).status).toBe(400);
    }
  });

  it('selects old finished runs, oldest first, never the latest passed run or a running one', async () => {
    expect(await prunableRuns(baseEnv.DB, ago(30), 10)).toEqual(['run_prune_old_failed', 'run_prune_old_passed']);
    const dry = await request(env, 'POST', '/api/admin/prune', { token: operator, body: { dryRun: true } });
    expect(dry.status).toBe(200);
    const plan = (await dry.json()) as { runs: Array<{ runId: string }>; dryRun: boolean };
    expect(plan.dryRun).toBe(true);
    expect(plan.runs.map((r) => r.runId)).toEqual(['run_prune_old_failed', 'run_prune_old_passed']);
    expect((await counts('run_prune_old_failed')).edges).toBeGreaterThan(0);
  });

  it('deletes lineage detail in at most 4 D1 statements and keeps runs, checks, incidents and the baseline', async () => {
    const before = await counts('run_prune_old_failed');
    expect(before.nodes).toBe(42);
    expect(before.lineageObjects).toBe(2);
    const baseline = await baselineChecksums(baseEnv.DB, 'run_prune_recent_failed');
    const { db, counter } = countingDb(baseEnv.DB);
    const res = await request({ ...env, DB: db }, 'POST', '/api/admin/prune', { token: operator, body: { maxRuns: 1 } });
    expect(res.status).toBe(200);
    const out = (await res.json()) as {
      runs: Array<{ runId: string; r2Deleted: number; r2Remaining: boolean }>;
      d1: { edges: number; events: number; nodes: number };
      more: boolean;
    };
    expect(out.runs).toEqual([{ runId: 'run_prune_old_failed', r2Deleted: 2, r2Remaining: false }]);
    expect(out.d1).toEqual({ edges: before.edges, events: 2, nodes: 42 });
    expect(out.more).toBe(true);
    expect(counter.statements).toBeLessThanOrEqual(4);
    expect(await counts('run_prune_old_failed')).toEqual({ ...before, edges: 0, events: 0, nodes: 0, lineageObjects: 0 });

    const second = (await (await request(env, 'POST', '/api/admin/prune', { token: operator, body: {} })).json()) as typeof out;
    expect(second.runs.map((r) => r.runId)).toEqual(['run_prune_old_passed']);
    expect(second.more).toBe(false);
    const third = (await (await request(env, 'POST', '/api/admin/prune', { token: operator, body: {} })).json()) as typeof out;
    expect(third.runs).toEqual([]);
    expect(third.d1).toEqual({ edges: 0, events: 0, nodes: 0 });

    for (const kept of ['run_prune_latest_passed', 'run_prune_old_running', 'run_prune_recent_failed']) {
      expect((await counts(kept)).nodes).toBe(42);
      expect((await counts(kept)).lineageObjects).toBe(2);
    }
    expect(await baselineChecksums(baseEnv.DB, 'run_prune_recent_failed')).toEqual(baseline);
  });
});
