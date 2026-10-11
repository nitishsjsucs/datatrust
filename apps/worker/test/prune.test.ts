/**
 * POST /api/admin/prune (SPEC risk 25): old runs lose their lineage detail (D1 edges, events and nodes, R2
 * `lineage/<runId>/`), everything else stays, the latest passed run is kept as the investigation baseline, and
 * one call stays inside the Free plan's per-invocation limits.
 */
import { env as baseEnv } from 'cloudflare:workers';
import { buildLineageGraph } from '@datatrust/rca';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AppEnv } from '../src/env';
import { PRUNE_DAILY_ROWS, PRUNE_ROWS_PER_RUN } from '../src/schemas';
import {
  baselineChecksums,
  type EdgeRow,
  lineageBundleStatements,
  prunableRuns,
  pruneLedger,
  recordPrune,
  upsertLineageGraph,
} from '../src/store/repo';
import { request } from './helpers/app';
import { countingDb } from './helpers/counting-db';
import { s01 } from './helpers/fixtures';
import { humanClaims, type Keys, makeKeys, mint, OPERATOR, serviceClaims, testEnv, VIEWER } from './helpers/keys';

let keys: Keys;
let env: AppEnv;
let operator: string;

const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

/** Lineage rows of a full seed-101 run (SPEC 28.3; free_budget.py): 275 edges, 140 OpenLineage events, 42 nodes. */
const FULL = { edges: 275, events: 140, nodes: 42 };

/**
 * A run with a seed-101 lineage graph, lineage event rows and objects, a check result and an incident. With
 * `full`, the graph is padded to a whole seed-101 run's 275 edges and 140 event rows (two R2 objects either way).
 */
async function seedRun(runId: string, status: string, createdDaysAgo: number, full = false) {
  const db = baseEnv.DB;
  await db
    .prepare(`INSERT INTO runs (run_id, target, seed, scenario, status, created_at, finished_at) VALUES (?, 'duckdb', 101, NULL, ?, ?, ?)`)
    .bind(runId, status, ago(createdDaysAgo), status === 'running' ? null : ago(createdDaysAgo))
    .run();
  const graph = buildLineageGraph(s01.events, s01.relations);
  await upsertLineageGraph(db, runId, graph);
  const edgeCount = graph.columnEdges.length + graph.datasetEdges.length;
  const padding: EdgeRow[] = full
    ? Array.from({ length: FULL.edges - edgeCount }, (_, i): EdgeRow => ['model.datatrust.pad_src', `c${i}`, 'model.datatrust.pad_dst', `c${i}`])
    : [];
  const events = Array.from({ length: full ? FULL.events : 2 }, (_, i) => ({ eventId: `e${i}`, r2Key: `lineage/${runId}/e${i}.json` }));
  await db.batch(lineageBundleStatements(db, runId, padding, events));
  for (const e of events.slice(0, 2)) await baseEnv.ARTIFACTS.put(e.r2Key, '{}');
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
  await seedRun('run_prune_old_failed', 'failed', 60, true);
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
    for (const body of [{ olderThanDays: 6 }, { maxRuns: 6 }, { maxRuns: 0 }]) {
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

  it('deletes lineage detail in at most 6 D1 statements and keeps runs, checks, incidents and the baseline', async () => {
    const before = await counts('run_prune_old_failed');
    expect({ edges: before.edges, events: before.events, nodes: before.nodes }).toEqual(FULL);
    expect(before.lineageObjects).toBe(2);
    const baseline = await baselineChecksums(baseEnv.DB, 'run_prune_recent_failed');
    const { db, counter } = countingDb(baseEnv.DB);
    const res = await request({ ...env, DB: db }, 'POST', '/api/admin/prune', { token: operator, body: { maxRuns: 1 } });
    expect(res.status).toBe(200);
    const out = (await res.json()) as {
      runs: Array<{ runId: string; r2Deleted: number; r2Remaining: boolean }>;
      d1: { edges: number; events: number; nodes: number; rowsWritten: number };
      ledger: { rowsWritten: number; runs: number; cap: number };
      more: boolean;
    };
    expect(out.runs).toEqual([{ runId: 'run_prune_old_failed', r2Deleted: 2, r2Remaining: false }]);
    // D1's own count (meta.rows_written) for a whole seed-101 run, measured in Miniflare: one per deleted row,
    // 275 + 140 + 42 = 457. The D1 pricing page says an index adds a written row, so production may count each
    // primary-key index entry too; the budget and the ledger's fit check use that upper bound, 2 x 457 = 914.
    const rows = FULL.edges + FULL.events + FULL.nodes;
    expect(out.d1).toEqual({ ...FULL, rowsWritten: rows });
    expect(PRUNE_ROWS_PER_RUN).toBe(2 * rows);
    expect(out.ledger).toMatchObject({ rowsWritten: rows, runs: 1, cap: PRUNE_DAILY_ROWS });
    expect(out.more).toBe(true);
    expect(counter.statements).toBeLessThanOrEqual(6);
    expect(await counts('run_prune_old_failed')).toEqual({ ...before, edges: 0, events: 0, nodes: 0, lineageObjects: 0 });

    const second = (await (await request(env, 'POST', '/api/admin/prune', { token: operator, body: {} })).json()) as typeof out;
    expect(second.runs.map((r) => r.runId)).toEqual(['run_prune_old_passed']);
    expect(second.more).toBe(false);
    const third = (await (await request(env, 'POST', '/api/admin/prune', { token: operator, body: {} })).json()) as typeof out;
    expect(third.runs).toEqual([]);
    expect(third.d1).toEqual({ edges: 0, events: 0, nodes: 0, rowsWritten: 0 });

    for (const kept of ['run_prune_latest_passed', 'run_prune_old_running', 'run_prune_recent_failed']) {
      expect((await counts(kept)).nodes).toBe(42);
      expect((await counts(kept)).lineageObjects).toBe(2);
    }
    expect(await baselineChecksums(baseEnv.DB, 'run_prune_recent_failed')).toEqual(baseline);
  });

  it('stops for the UTC day once the ledger reaches the daily cap', async () => {
    const day = new Date().toISOString().slice(0, 10);
    const spent = await pruneLedger(baseEnv.DB, day);
    // Leave room for less than one run.
    await recordPrune(baseEnv.DB, day, PRUNE_DAILY_ROWS - spent.rowsWritten - PRUNE_ROWS_PER_RUN + 1, 0);
    await seedRun('run_prune_capped', 'failed', 90);
    const res = await request(env, 'POST', '/api/admin/prune', { token: operator, body: {} });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { runs: unknown[]; refused?: string; more: boolean };
    expect(out).toMatchObject({ runs: [], refused: 'daily_prune_cap', more: true });
    expect((await counts('run_prune_capped')).nodes).toBe(42);
  });
});
