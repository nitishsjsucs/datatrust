import type { AppEnv } from '../env';
import { handleCheckResults } from './check-results';
import { handleDeadLetters } from './dlq';
import { handleInvestigate } from './investigate';
import { handleLineageEvents } from './lineage-events';

/** Dispatch by queue name (SPEC 13.3). */
export async function queue(batch: MessageBatch<unknown>, env: AppEnv): Promise<void> {
  switch (batch.queue) {
    case 'dt-check-results':
      return handleCheckResults(batch, env);
    case 'dt-lineage-events':
      return handleLineageEvents(batch, env);
    case 'dt-investigate':
      return handleInvestigate(batch, env);
    case 'dt-dlq':
      return handleDeadLetters(batch, env);
    default:
      console.error(`unknown queue ${batch.queue}`);
      batch.ackAll();
  }
}
