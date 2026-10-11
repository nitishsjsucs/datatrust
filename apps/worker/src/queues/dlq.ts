import type { AppEnv } from '../env';
import { insertDeadLetter } from '../store/repo';

/** datatrust-dlq: keep every dead letter in D1 for inspection (SPEC 13.3). */
export async function handleDeadLetters(batch: MessageBatch<unknown>, env: AppEnv): Promise<void> {
  for (const msg of batch.messages) {
    await insertDeadLetter(env.DB, batch.queue, msg.body, `attempts=${msg.attempts}`);
    msg.ack();
  }
}
