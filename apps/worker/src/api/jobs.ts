import type { AppEnv } from '../env';
import type { JobRow } from '../store/repo';

/** Send a job's workflow event (build-complete or diagnostics-complete) to its workflow instance. */
export async function sendJobEvent(env: AppEnv, job: JobRow, payload: Record<string, unknown>): Promise<void> {
  if (!job.workflow_instance_id || !job.event_type) return;
  const binding = job.kind === 'dbt_build' ? env.VALIDATION_RUN : env.INVESTIGATION;
  const instance = await binding.get(job.workflow_instance_id);
  await instance.sendEvent({ type: job.event_type, payload: { jobId: job.job_id, ...payload } });
}
