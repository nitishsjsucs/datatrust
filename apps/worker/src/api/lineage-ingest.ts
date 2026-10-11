/**
 * POST /api/v1/lineage: one OpenLineage RunEvent or an array (also usable as an OpenLineage HTTP transport
 * target with custom headers). Requires the job id and lease token of a leased dbt_build job; events are
 * filed under that job's run, stored in R2 and announced on dt-lineage-events (SPEC 9, 13.1).
 */
import { RunEventSchema } from '@datatrust/rca';
import { Hono } from 'hono';
import { type HonoEnv, requireRole } from '../hono';
import { canonicalJson, sha256Hex } from '../ids';
import { getJob, insertLineageEvent, isLeaseValid } from '../store/repo';
import { JOB_HEADER, LEASE_HEADER } from './runner';

export const lineageIngest = new Hono<HonoEnv>();

lineageIngest.post('/', requireRole('runner'), async (c) => {
  const job = await getJob(c.env.DB, c.req.header(JOB_HEADER) ?? '');
  if (!isLeaseValid(job, c.req.header(LEASE_HEADER) ?? null) || job.kind !== 'dbt_build') {
    return c.json({ error: 'forbidden' }, 403);
  }
  const raw = await c.req.json().catch(() => null);
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  if (list.length === 0 || list.length > 500) return c.json({ error: 'invalid_body' }, 400);
  const eventIds: string[] = [];
  const messages: Array<{ body: { runId: string; eventId: string; r2Key: string } }> = [];
  for (const item of list) {
    const parsed = RunEventSchema.safeParse(item);
    if (!parsed.success) return c.json({ error: 'invalid_event' }, 400);
    const eventId = (await sha256Hex(canonicalJson(item))).slice(0, 32);
    const r2Key = `lineage/${job.run_id}/${eventId}.json`;
    await c.env.ARTIFACTS.put(r2Key, JSON.stringify(item), { httpMetadata: { contentType: 'application/json' } });
    await insertLineageEvent(c.env.DB, job.run_id, eventId, r2Key);
    eventIds.push(eventId);
    messages.push({ body: { runId: job.run_id, eventId, r2Key } });
  }
  for (let i = 0; i < messages.length; i += 100) await c.env.LINEAGE_Q.sendBatch(messages.slice(i, i + 100));
  return c.json({ accepted: eventIds.length, eventIds }, 202);
});
