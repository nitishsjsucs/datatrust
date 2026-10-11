/**
 * POST /api/v1/lineage: one OpenLineage RunEvent or an array of at most 10 events and 256 KB (SPEC 13.1,
 * 28.5.2). Requires the job id and lease token of a leased dbt_build job; events are filed under that job's
 * run, stored in R2, and announced with ONE message on datatrust-lineage-events. No D1 write here: the
 * bundle consumer inserts the edges and the lineage_events rows. A single event still works (an OpenLineage
 * HTTP transport target with custom headers), but costs a queue message per event.
 */
import { RunEventSchema } from '@datatrust/rca';
import { Hono } from 'hono';
import { type HonoEnv, requireRole } from '../hono';
import { sha256Hex } from '../ids';
import type { LineageBundle } from '../schemas';
import { getJob, isLeaseValid } from '../store/repo';
import { JOB_HEADER, LEASE_HEADER } from './runner';

/** Free plan budget (SPEC 28.5.2): 10 events and 256 KB per POST keep the handler near 3 ms of CPU. */
export const LINEAGE_POST_MAX_EVENTS = 10;
export const LINEAGE_POST_MAX_BYTES = 262_144;

export const lineageIngest = new Hono<HonoEnv>();

lineageIngest.post('/', requireRole('runner'), async (c) => {
  const declared = Number(c.req.header('content-length') ?? 0);
  if (declared > LINEAGE_POST_MAX_BYTES) return c.json({ error: 'too_large', maxBytes: LINEAGE_POST_MAX_BYTES }, 413);
  const job = await getJob(c.env.DB, c.req.header(JOB_HEADER) ?? '');
  if (!isLeaseValid(job, c.req.header(LEASE_HEADER) ?? null) || job.kind !== 'dbt_build') {
    return c.json({ error: 'forbidden' }, 403);
  }
  const buf = await c.req.arrayBuffer();
  if (buf.byteLength > LINEAGE_POST_MAX_BYTES) return c.json({ error: 'too_large', maxBytes: LINEAGE_POST_MAX_BYTES }, 413);
  let raw: unknown = null;
  try {
    raw = JSON.parse(new TextDecoder().decode(buf));
  } catch {
    return c.json({ error: 'invalid_body' }, 400);
  }
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  if (list.length === 0) return c.json({ error: 'invalid_body' }, 400);
  if (list.length > LINEAGE_POST_MAX_EVENTS) {
    return c.json({ error: 'too_many_events', maxEvents: LINEAGE_POST_MAX_EVENTS }, 413);
  }
  for (const item of list) {
    if (!RunEventSchema.safeParse(item).success) return c.json({ error: 'invalid_event' }, 400);
  }
  const events: LineageBundle['events'] = [];
  for (const item of list) {
    // The id hashes the event as received: the runner resends the same JSON on a retry, so it is stable.
    const json = JSON.stringify(item);
    const eventId = (await sha256Hex(json)).slice(0, 32);
    const r2Key = `lineage/${job.run_id}/${eventId}.json`;
    await c.env.ARTIFACTS.put(r2Key, json, { httpMetadata: { contentType: 'application/json' } });
    events.push({ eventId, r2Key });
  }
  const bundle: LineageBundle = { runId: job.run_id, events };
  await c.env.LINEAGE_Q.send(bundle);
  return c.json({ accepted: events.length, eventIds: events.map((e) => e.eventId) }, 202);
});
