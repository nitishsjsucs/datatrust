import type { CheckResult } from '@datatrust/rca';
import type { AppEnv } from '../env';
import { auditEvent, auditEventId, createSink } from '../sinks/event-sink';
import { upsertCheckResults } from '../store/repo';

const isString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/**
 * Shape check for a message this Worker produced itself: the completion handler already validated every
 * check result with the full zod schema (CompleteSchema) before enqueueing it, so the consumer checks only the
 * fields it uses, in plain code. Re-running zod (jitless, as in workerd) on 41 results per message cost about
 * 0.2 ms each, 2 ms for a batch of 10, against the Free plan's 10 ms per invocation (SPEC 28.5.3).
 */
export function checkResultsMessage(body: unknown): { runId: string; checkResults: CheckResult[] } | null {
  if (!body || typeof body !== 'object') return null;
  const { runId, checkResults } = body as { runId?: unknown; checkResults?: unknown };
  if (!isString(runId) || !Array.isArray(checkResults) || checkResults.length > 100) return null;
  for (const c of checkResults as Array<Record<string, unknown>>) {
    if (
      !c ||
      typeof c !== 'object' ||
      !isString(c['checkId']) ||
      !isString(c['testName']) ||
      !isString(c['category']) ||
      !isString(c['kind']) ||
      !['pass', 'fail', 'error', 'skip'].includes(c['status'] as string) ||
      typeof c['failures'] !== 'number' ||
      !isString(c['node']) ||
      !Array.isArray(c['columns'])
    ) {
      return null;
    }
  }
  return { runId, checkResults: checkResults as CheckResult[] };
}

/** datatrust-check-results: upsert check results into D1 and emit check_result audit events (SPEC 13.3, 13.9). */
export async function handleCheckResults(batch: MessageBatch<unknown>, env: AppEnv): Promise<void> {
  const sink = createSink(env);
  for (const msg of batch.messages) {
    const message = checkResultsMessage(msg.body);
    const parsed = message ? { data: message } : null;
    if (!parsed) {
      msg.ack(); // malformed: never retry; it cannot succeed
      console.error('datatrust-check-results: malformed message');
      continue;
    }
    try {
      await upsertCheckResults(env.DB, parsed.data.runId, parsed.data.checkResults);
      await sink.send(
        parsed.data.checkResults.map((c) =>
          auditEvent(env, 'check_result', parsed.data.runId, {
            event_id: auditEventId.checkResult(parsed.data.runId, c.checkId),
            check_id: c.checkId,
            status: c.status,
            node: c.node,
            payload: { category: c.category, kind: c.kind, failures: c.failures, columns: c.columns },
          }),
        ),
      );
      msg.ack();
    } catch (err) {
      console.error('datatrust-check-results', err);
      msg.retry();
    }
  }
}
