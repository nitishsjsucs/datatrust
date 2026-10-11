/**
 * POST /api/admin/prune (operator): removes the lineage detail of old runs so the Free plan's 500 MB D1
 * database does not fill (SPEC risk 25, about 3,000 runs at 167 KB each). Per pruned run it deletes the D1
 * lineage edges, events and nodes and the raw OpenLineage events under R2 `lineage/<runId>/`; run rows, jobs,
 * check results, incidents, `runs/` artifacts and the audit lake stay. Deletes count as D1 rows written, so a
 * daily ledger (`prune_budget`) records each call's measured rows and stops pruning for the UTC day before
 * PRUNE_DAILY_ROWS would be passed. Bounded per call (at most 5 runs, one R2 list and one R2 delete per run,
 * six D1 statements), so a call fits the Free per-invocation limits.
 */
import { Hono } from 'hono';
import { type HonoEnv, requireRole } from '../hono';
import { PRUNE_DAILY_ROWS, PRUNE_ROWS_PER_RUN, PruneSchema } from '../schemas';
import { prunableRuns, pruneLedger, pruneLineageRows, recordPrune } from '../store/repo';

export const admin = new Hono<HonoEnv>();

const DAY_MS = 24 * 60 * 60 * 1000;
/** One R2 list returns at most 1,000 keys; a seed-101 run stores about 135 lineage objects. */
const R2_PAGE = 1000;

admin.post('/prune', requireRole('operator'), async (c) => {
  const body = PruneSchema.safeParse((await c.req.json().catch(() => ({}))) ?? {});
  if (!body.success) return c.json({ error: 'invalid_body' }, 400);
  const { olderThanDays, maxRuns, dryRun } = body.data;
  const now = Date.now();
  const cutoff = new Date(now - olderThanDays * DAY_MS).toISOString();
  const day = new Date(now).toISOString().slice(0, 10);
  const spent = await pruneLedger(c.env.DB, day);
  const ledger = { day, ...spent, cap: PRUNE_DAILY_ROWS };
  // How many more runs fit today's ledger at the measured rows per run.
  const limit = Math.min(maxRuns, Math.max(0, Math.floor((PRUNE_DAILY_ROWS - spent.rowsWritten) / PRUNE_ROWS_PER_RUN)));
  if (limit === 0) {
    return c.json({ cutoff, dryRun, runs: [], refused: 'daily_prune_cap', ledger, more: true });
  }
  const candidates = await prunableRuns(c.env.DB, cutoff, limit);
  const more = candidates.length === limit;
  if (dryRun) return c.json({ cutoff, dryRun, runs: candidates.map((runId) => ({ runId })), ledger, more });

  // R2 first: a run whose listing was truncated keeps its D1 rows, so the next call selects it again.
  const runs: Array<{ runId: string; r2Deleted: number; r2Remaining: boolean }> = [];
  for (const runId of candidates) {
    const listed = await c.env.ARTIFACTS.list({ prefix: `lineage/${runId}/`, limit: R2_PAGE });
    const keys = listed.objects.map((o) => o.key);
    if (keys.length) await c.env.ARTIFACTS.delete(keys);
    runs.push({ runId, r2Deleted: keys.length, r2Remaining: listed.truncated });
  }
  const finished = runs.filter((r) => !r.r2Remaining).map((r) => r.runId);
  const d1 = await pruneLineageRows(c.env.DB, finished);
  if (finished.length) await recordPrune(c.env.DB, day, d1.rowsWritten, finished.length);
  return c.json({
    cutoff,
    dryRun,
    runs,
    d1,
    ledger: { ...ledger, rowsWritten: spent.rowsWritten + d1.rowsWritten, runs: spent.runs + finished.length },
    more: more || runs.some((r) => r.r2Remaining),
  });
});
