import { Hono } from 'hono';
import { type HonoEnv, requireRole } from '../hono';
import { getRun, listCheckResults } from '../store/repo';

export const runs = new Hono<HonoEnv>();

runs.get('/:runId', requireRole('viewer', 'operator'), async (c) => {
  const run = await getRun(c.env.DB, c.req.param('runId'));
  if (!run) return c.json({ error: 'not_found' }, 404);
  const checks = await listCheckResults(c.env.DB, run.run_id);
  const counts = { pass: 0, fail: 0, error: 0, skip: 0 };
  for (const ch of checks) counts[ch.status] += 1;
  return c.json({
    runId: run.run_id,
    status: run.status,
    target: run.target,
    seed: run.seed,
    scenario: run.scenario,
    createdAt: run.created_at,
    finishedAt: run.finished_at,
    workflowInstanceId: run.workflow_instance_id,
    checkCounts: counts,
    failing: checks.filter((ch) => ch.status === 'fail' || ch.status === 'error').map((ch) => ch.checkId),
    incidentId: run.incident_id,
  });
});
