import type { AppEnv } from '../env';
import type { JobRow } from '../store/repo';

/**
 * What became of a job's workflow event: delivered, or not deliverable because the instance no longer exists
 * (the Free plan keeps finished instances 3 days) or already finished (it timed out or ended). The last two
 * are final, so the caller logs them instead of failing; any other error is thrown, so the runner retries.
 */
export type JobEventOutcome = 'delivered' | 'instance_gone' | 'instance_finished';

const FINISHED = new Set(['complete', 'errored', 'terminated']);

function isNotFound(err: unknown): boolean {
  return err instanceof Error && /not[_ ]found/i.test(err.message);
}

/** Send a job's workflow event (build-complete or diagnostics-complete) to its workflow instance. */
export async function sendJobEvent(env: AppEnv, job: JobRow, payload: Record<string, unknown>): Promise<JobEventOutcome> {
  if (!job.workflow_instance_id || !job.event_type) return 'instance_gone';
  const binding = job.kind === 'dbt_build' ? env.VALIDATION_RUN : env.INVESTIGATION;
  let instance: WorkflowInstance;
  try {
    instance = await binding.get(job.workflow_instance_id);
  } catch (err) {
    if (isNotFound(err)) return 'instance_gone';
    throw err;
  }
  try {
    await instance.sendEvent({ type: job.event_type, payload: { jobId: job.job_id, ...payload } });
    return 'delivered';
  } catch (err) {
    if (isNotFound(err)) return 'instance_gone';
    const state = await instance.status().catch(() => null);
    if (state && FINISHED.has(state.status)) return 'instance_finished';
    throw err;
  }
}
