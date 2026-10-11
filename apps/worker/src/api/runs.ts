import { Hono } from 'hono';
import { type HonoEnv, requireRole } from '../hono';
import { ulid } from '../ids';
import { CreateRunSchema } from '../schemas';
import { bigQueryRunInFlight, finishRun, getRun, insertBigQueryRunIfIdle, insertRun, listCheckResults } from '../store/repo';

export const runs = new Hono<HonoEnv>();

/**
 * Insert the run row first, so an immediate GET never 404s, then create the workflow (SPEC 13.1). BigQuery
 * runs go one at a time: every one builds the same datasets, so another is refused with 409 while one is in
 * flight (queued, running, or failed and still being investigated). If the workflow cannot be created, the
 * row is closed as 'error' rather than left 'queued' for ever.
 */
runs.post('/', requireRole('operator'), async (c) => {
  const body = CreateRunSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: 'invalid_body' }, 400);
  const runId = `run_${ulid()}`;
  const target = body.data.target;
  const seed = body.data.seed ?? 101;
  const scenario = body.data.scenario ?? null;
  if (target === 'bigquery') {
    if (!(await insertBigQueryRunIfIdle(c.env.DB, { runId, seed, scenario }))) {
      const busy = await bigQueryRunInFlight(c.env.DB);
      return c.json({ error: 'bigquery_run_in_flight', runId: busy?.run_id ?? null, status: busy?.status ?? null }, 409);
    }
  } else {
    await insertRun(c.env.DB, { runId, target, seed, scenario });
  }
  try {
    await c.env.VALIDATION_RUN.create({ id: runId, params: { runId, target, seed, scenario } });
  } catch (err) {
    console.error(`runs: workflow for ${runId} not created`, err);
    await finishRun(c.env.DB, runId, 'error');
    return c.json({ error: 'workflow_not_created', runId }, 500);
  }
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
