import type { AppEnv } from '../env';
import { CheckResultsMessage } from '../schemas';
import { auditEvent, createSink } from '../sinks/event-sink';
import { upsertCheckResults } from '../store/repo';

/** dt-check-results: upsert check results into D1 and emit check_result audit events (SPEC 13.3, 13.9). */
export async function handleCheckResults(batch: MessageBatch<unknown>, env: AppEnv): Promise<void> {
  const sink = createSink(env);
  for (const msg of batch.messages) {
    const parsed = CheckResultsMessage.safeParse(msg.body);
    if (!parsed.success) {
      msg.ack(); // malformed: never retry; it cannot succeed
      console.error('dt-check-results: malformed message');
      continue;
    }
    try {
      await upsertCheckResults(env.DB, parsed.data.runId, parsed.data.checkResults);
      await sink.send(
        parsed.data.checkResults.map((c) =>
          auditEvent(env, 'check_result', parsed.data.runId, {
            check_id: c.checkId,
            status: c.status,
            node: c.node,
            payload: { category: c.category, kind: c.kind, failures: c.failures, columns: c.columns },
          }),
        ),
      );
      msg.ack();
    } catch (err) {
      console.error('dt-check-results', err);
      msg.retry();
    }
  }
}
