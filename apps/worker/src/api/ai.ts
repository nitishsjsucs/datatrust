/** GET /api/ai/budget (operator): today's Workers AI neuron ledger (UTC day) and the cap (SPEC 28.5.5). */
import { Hono } from 'hono';
import { type HonoEnv, requireRole } from '../hono';
import { budgetStatus, dailyCap, utcDay } from '../llm/budget';

export const ai = new Hono<HonoEnv>();

ai.get('/budget', requireRole('operator'), async (c) => {
  const cap = dailyCap(c.env.AI_DAILY_NEURON_CAP);
  if (cap === null) return c.json({ error: 'misconfigured' }, 500);
  const status = await budgetStatus(c.env.DB, utcDay(new Date()), cap);
  return c.json({ ...status, model: c.env.WORKERS_AI_MODEL, summarizer: c.env.SUMMARIZER });
});
