import type { AppEnv } from '../env';
import { CheckResultsMessage } from '../schemas';
import { upsertCheckResults } from '../store/repo';

/** dt-check-results: upsert check results into D1 (SPEC 13.3). */
export async function handleCheckResults(batch: MessageBatch<unknown>, env: AppEnv): Promise<void> {
  for (const msg of batch.messages) {
    const parsed = CheckResultsMessage.safeParse(msg.body);
    if (!parsed.success) {
      msg.ack(); // malformed: never retry; it cannot succeed
      console.error('dt-check-results: malformed message');
      continue;
    }
    try {
      await upsertCheckResults(env.DB, parsed.data.runId, parsed.data.checkResults);
      msg.ack();
    } catch (err) {
      console.error('dt-check-results', err);
      msg.retry();
    }
  }
}
