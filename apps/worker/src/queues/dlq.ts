import type { AppEnv } from '../env';
import { insertDeadLetters } from '../store/repo';
import { QUEUES } from './names';

/**
 * The queue a dead letter came from, from its body: every DataTrust queue carries its own message shape, and a
 * DLQ batch only names the DLQ itself (`batch.queue` is datatrust-dlq).
 */
export function originQueue(body: unknown): string {
  if (!body || typeof body !== 'object') return 'unknown';
  const b = body as Record<string, unknown>;
  if (Array.isArray(b['checkResults'])) return QUEUES.checkResults;
  if (typeof b['incidentId'] === 'string' && typeof b['trigger'] === 'string') return QUEUES.investigate;
  if (Array.isArray(b['events'])) {
    const first = b['events'][0] as Record<string, unknown> | undefined;
    if (first && 'r2Key' in first) return QUEUES.lineageEvents;
    if (first && 'event_id' in first) return QUEUES.auditEvents;
  }
  return 'unknown';
}

/** datatrust-dlq: keep every dead letter in D1 with its origin queue, one statement per batch (SPEC 13.3, 28.5.3). */
export async function handleDeadLetters(batch: MessageBatch<unknown>, env: AppEnv): Promise<void> {
  await insertDeadLetters(
    env.DB,
    batch.messages.map((m) => ({ queue: originQueue(m.body), body: m.body, error: `attempts=${m.attempts}` })),
  );
  for (const m of batch.messages) m.ack();
}
