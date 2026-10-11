import type { AppEnv } from '../env';
import { investigationIds } from '../investigation-ids';
import { InvestigateMessage } from '../schemas';
import { incidentExists } from '../store/repo';

/**
 * datatrust-investigate: create the InvestigationWorkflow instance inv_<runId>_<trigger>_<hash8> (SPEC 13.3).
 * create() throws when the id is already used, so a redelivered message is acknowledged (idempotent). That
 * only holds while the instance is retained (3 days on the Free plan), so the consumer first checks for the
 * incident row (one indexed read) and acks without creating anything when it exists: the same alert after
 * the retention can neither start a second investigation nor spend Workers AI neurons twice (SPEC 28.5.7).
 */
export async function handleInvestigate(batch: MessageBatch<unknown>, env: AppEnv): Promise<void> {
  for (const msg of batch.messages) {
    const parsed = InvestigateMessage.safeParse(msg.body);
    if (!parsed.success) {
      msg.ack();
      console.error('datatrust-investigate: malformed message');
      continue;
    }
    const m = parsed.data;
    const ids = await investigationIds(m.runId, m.trigger, m.alert);
    if (await incidentExists(env.DB, ids.incidentId)) {
      msg.ack();
      continue;
    }
    try {
      await env.INVESTIGATION.create({
        id: ids.instanceId,
        params: { runId: m.runId, incidentId: ids.incidentId, trigger: m.trigger, alert: m.alert },
      });
      msg.ack();
    } catch (err) {
      const text = String(err instanceof Error ? err.message : err);
      if (/already exist|already been used|duplicate|already taken/i.test(text)) {
        msg.ack();
      } else {
        console.error('datatrust-investigate', err);
        msg.retry({ delaySeconds: 2 });
      }
    }
  }
}
