import type { AppEnv } from '../env';
import { ulid } from '../ids';
import { type AuditEvent, schemaProblems } from '../sinks/event-sink';

/** R2 key of a lake object: keys sort by the time they were written (SPEC 28.5.1). */
export function lakeKey(nowMs: number): string {
  return `lake/${new Date(nowMs).toISOString().slice(0, 10)}/${ulid(nowMs)}.ndjson`;
}

function eventsOf(body: unknown): AuditEvent[] | null {
  if (!body || typeof body !== 'object' || !Array.isArray((body as { events?: unknown }).events)) return null;
  const events = (body as { events: unknown[] }).events;
  if (!events.length) return null;
  for (const e of events) {
    if (!e || typeof e !== 'object' || schemaProblems(e as Record<string, unknown>).length) return null;
  }
  return events as AuditEvent[];
}

/**
 * datatrust-audit-events: write the whole batch as one new, immutable NDJSON object in R2 and ack it (SPEC
 * 13.3, 28.5.1). Objects are never overwritten; a redelivered batch writes another object with the same
 * event ids, which the committer drops (exactly once per event_id in the Iceberg table).
 */
export async function handleAuditEvents(batch: MessageBatch<unknown>, env: AppEnv): Promise<void> {
  const valid: Array<{ msg: Message<unknown>; events: AuditEvent[] }> = [];
  for (const msg of batch.messages) {
    const events = eventsOf(msg.body);
    if (!events) {
      msg.ack(); // malformed: retrying cannot help
      console.error('datatrust-audit-events: malformed message');
      continue;
    }
    valid.push({ msg, events });
  }
  if (!valid.length) return;
  const lines = valid.flatMap((v) => v.events).map((e) => JSON.stringify(e));
  try {
    await env.ARTIFACTS.put(lakeKey(Date.now()), lines.join('\n') + '\n', {
      httpMetadata: { contentType: 'application/x-ndjson' },
    });
    for (const v of valid) v.msg.ack();
  } catch (err) {
    console.error('datatrust-audit-events', err);
    for (const v of valid) v.msg.retry({ delaySeconds: 5 });
  }
}
