import type { AppEnv } from '../env';
import { insertDeadLetters } from '../store/repo';

/** datatrust-dlq: keep every dead letter in D1 for inspection, one statement per batch (SPEC 13.3, 28.5.3). */
export async function handleDeadLetters(batch: MessageBatch<unknown>, env: AppEnv): Promise<void> {
  await insertDeadLetters(
    env.DB,
    batch.queue,
    batch.messages.map((m) => ({ body: m.body, error: `attempts=${m.attempts}` })),
  );
  for (const m of batch.messages) m.ack();
}
