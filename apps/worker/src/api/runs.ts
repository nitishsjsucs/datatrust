import { Hono } from 'hono';
import { type HonoEnv, requireRole } from '../hono';
import { ulid } from '../ids';
import { CreateRunSchema } from '../schemas';
import { getRun, insertRun, listCheckResults } from '../store/repo';

export const runs = new Hono<HonoEnv>();

/** Insert the run row first, so an immediate GET never 404s, then create the workflow (SPEC 13.1). */
runs.post('/', requireRole('operator'), async (c) => {
  const body = CreateRunSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: 'invalid_body' }, 400);
  const runId = `run_${ulid()}`;
  const seed = body.data.seed ?? 101;
  const scenario = body.data.scenario ?? null;
  await insertRun(c.env.DB, { runId, target: body.data.target, seed, scenario });
  await c.env.VALIDATION_RUN.create({ id: runId, params: { runId, target: body.data.target, seed, scenario } });
  return c.json({ runId }, 201);
});

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
