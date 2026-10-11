import type { AppEnv } from '../env';
import { handleAuditEvents } from './audit-events';
import { handleCheckResults } from './check-results';
import { handleDeadLetters } from './dlq';
import { handleInvestigate } from './investigate';
import { handleLineageEvents } from './lineage-events';

/** Queue names carry the repo prefix: one Cloudflare account serves four repos (SPEC 13.3, 28.5.8). */
export const QUEUES = {
  checkResults: 'datatrust-check-results',
  lineageEvents: 'datatrust-lineage-events',
  investigate: 'datatrust-investigate',
  auditEvents: 'datatrust-audit-events',
  dlq: 'datatrust-dlq',
} as const;

/** Dispatch by queue name (SPEC 13.3). */
export async function queue(batch: MessageBatch<unknown>, env: AppEnv): Promise<void> {
  switch (batch.queue) {
    case QUEUES.checkResults:
      return handleCheckResults(batch, env);
    case QUEUES.lineageEvents:
      return handleLineageEvents(batch, env);
    case QUEUES.investigate:
      return handleInvestigate(batch, env);
    case QUEUES.auditEvents:
      return handleAuditEvents(batch, env);
    case QUEUES.dlq:
      return handleDeadLetters(batch, env);
    default:
      console.error(`unknown queue ${batch.queue}`);
      batch.ackAll();
  }
}
