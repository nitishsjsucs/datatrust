/**
 * POST /api/admin/prune (operator): removes the lineage detail of old runs so the Free plan's 500 MB D1
 * database does not fill (SPEC risk 25, about 3,000 runs at 167 KB each). Per pruned run it deletes the D1
 * lineage edges, events and nodes and the raw OpenLineage events under R2 `lineage/<runId>/`; run rows, jobs,
 * check results, incidents, `runs/` artifacts and the audit lake stay. Bounded per call (at most 10 runs, one
 * R2 list and one R2 delete per run, four D1 statements), so a call fits the Free per-invocation limits.
 */
import { Hono } from 'hono';
import { type HonoEnv, requireRole } from '../hono';
import { PruneSchema } from '../schemas';
import { prunableRuns, pruneLineageRows } from '../store/repo';

export const admin = new Hono<HonoEnv>();

const DAY_MS = 24 * 60 * 60 * 1000;
/** One R2 list returns at most 1,000 keys; a seed-101 run stores about 135 lineage objects. */
const R2_PAGE = 1000;

admin.post('/prune', requireRole('operator'), async (c) => {
  const body = PruneSchema.safeParse((await c.req.json().catch(() => ({}))) ?? {});
  if (!body.success) return c.json({ error: 'invalid_body' }, 400);
  const { olderThanDays, maxRuns, dryRun } = body.data;
  const cutoff = new Date(Date.now() - olderThanDays * DAY_MS).toISOString();
  const candidates = await prunableRuns(c.env.DB, cutoff, maxRuns);
  if (dryRun) return c.json({ cutoff, dryRun, runs: candidates.map((runId) => ({ runId })), more: candidates.length === maxRuns });

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
  return c.json({ cutoff, dryRun, runs, d1, more: candidates.length === maxRuns || runs.some((r) => r.r2Remaining) });
});
