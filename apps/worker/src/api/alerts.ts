/** POST /api/alerts: a failed metric reported by the runner or an operator starts an investigation (SPEC 13.1). */
import { Hono } from 'hono';
import { type HonoEnv, requireRole } from '../hono';
import { investigationIds } from '../investigation-ids';
import { AlertSchema } from '../schemas';
import { getRun } from '../store/repo';

export const alerts = new Hono<HonoEnv>();

alerts.post('/', requireRole('runner', 'operator'), async (c) => {
  const body = AlertSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: 'invalid_body' }, 400);
  if (!(await getRun(c.env.DB, body.data.runId))) return c.json({ error: 'not_found' }, 404);
  const ids = await investigationIds(body.data.runId, 'alert', body.data);
  await c.env.INVESTIGATE_Q.send({ runId: body.data.runId, incidentId: ids.incidentId, trigger: 'alert', alert: body.data });
  return c.json({ incidentId: ids.incidentId, workflowInstanceId: ids.instanceId }, 202);
});
