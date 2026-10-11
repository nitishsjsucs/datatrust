/**
 * POST /api/eval/summary (operator, production only; SPEC 12.4, 28.5.5, stretch): one sanitized evidence bundle
 * through the same grounded Workers AI loop as an incident, under the daily neuron ledger. The resumable eval
 * (`datatrust bench summaries --provider workers-ai --checkpoint ...`) posts the 20 seed-101 bundles one at a
 * time and stops for the day when an answer says `refused` (the ledger is at AI_DAILY_NEURON_CAP).
 */
import type { SanitizedEvidence } from '@datatrust/rca';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { type HonoEnv, requireRole } from '../hono';
import { finalizeSummary, shouldRepair, summarizeAttempt } from '../llm/attempt';
import { utcDay } from '../llm/budget';
import { createSummarizer, type Summarizer } from '../llm/summarizer';

export const EVAL_MAX_BYTES = 262_144;

const EvidenceSchema = z.looseObject({
  incidentId: z.string().min(1).max(200),
  runId: z.string().min(1).max(200),
  trigger: z.enum(['checks', 'alert']),
  failingChecks: z.array(z.looseObject({ key: z.string() })).max(100),
  candidates: z.array(z.looseObject({ key: z.string(), node: z.string() })).max(50),
  probes: z.array(z.looseObject({ key: z.string() })).max(200),
});

export async function evaluateSummary(env: AppEnv, s: Summarizer, evidence: SanitizedEvidence, now = new Date()) {
  const first = await summarizeAttempt(env, s, evidence, 1, null, now);
  const second = shouldRepair(s, first) ? await summarizeAttempt(env, s, evidence, 2, first, now) : null;
  const refused = first.refused || !!second?.refused;
  const outcome = finalizeSummary(s, evidence, first, second);
  return {
    // A refused call means the day's cap is reached: the eval stops and resumes after 00:00 UTC.
    refused,
    day: utcDay(now),
    rawDrafts: [first.raw, second?.raw].filter((x): x is string => typeof x === 'string'),
    ...outcome,
  };
}

export const evalRoutes = new Hono<HonoEnv>();

evalRoutes.post('/summary', requireRole('operator'), async (c) => {
  if (c.env.ENVIRONMENT !== 'production') return c.json({ error: 'not_found' }, 404);
  const buf = await c.req.arrayBuffer();
  if (buf.byteLength > EVAL_MAX_BYTES) return c.json({ error: 'too_large' }, 413);
  let body: unknown = null;
  try {
    body = JSON.parse(new TextDecoder().decode(buf));
  } catch {
    return c.json({ error: 'invalid_body' }, 400);
  }
  const parsed = z.object({ evidence: EvidenceSchema }).safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
  const out = await evaluateSummary(c.env, createSummarizer(c.env), parsed.data.evidence as unknown as SanitizedEvidence);
  return c.json(out);
});
