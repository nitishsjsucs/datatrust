import type { WorkflowStep, WorkflowStepConfig } from 'cloudflare:workers';

/**
 * Run a workflow step whose result is persisted as a JSON string. Workflow step results must be
 * serializable; serializing explicitly keeps that guarantee visible and keeps TypeScript out of the deep
 * structural `Serializable<T>` check for large lineage and ranking types.
 */
export async function jsonStep<T>(
  step: WorkflowStep,
  name: string,
  fn: () => Promise<T>,
  config?: WorkflowStepConfig,
): Promise<T> {
  const run = async () => JSON.stringify((await fn()) ?? null);
  const text = config ? await step.do(name, config, run) : await step.do(name, run);
  return JSON.parse(text) as T;
}

export const RETRY_INGEST: WorkflowStepConfig = {
  retries: { limit: 10, delay: '5 seconds', backoff: 'exponential' },
};

export const RETRY_LOAD: WorkflowStepConfig = {
  retries: { limit: 5, delay: '2 seconds', backoff: 'exponential' },
};

/** AI steps retry once at most; a provider error is returned, not thrown, so it never repeats a call. */
export const RETRY_AI: WorkflowStepConfig = {
  retries: { limit: 1, delay: '5 seconds', backoff: 'constant' },
};
