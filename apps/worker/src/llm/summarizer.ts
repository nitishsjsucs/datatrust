/**
 * Summarizer factory (SPEC 13.6). The grounded loop and the portable providers live in @datatrust/rca so the
 * Worker and the offline summary eval run the same code; Workers AI needs the binding and stays here.
 */
import { OpenAICompatSummarizer, type Summarizer, TemplateSummarizer } from '@datatrust/rca';
import type { AppEnv } from '../env';
import { WorkersAISummarizer } from './workers-ai';

export {
  OpenAICompatSummarizer,
  type ProviderName,
  type Summarizer,
  type SummaryOutcome,
  summarizeGrounded,
  TemplateSummarizer,
} from '@datatrust/rca';

/** Chooses the provider from the SUMMARIZER var. Production refuses anything but Workers AI. */
export function createSummarizer(
  env: AppEnv,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
): Summarizer {
  if (env.ENVIRONMENT === 'production' && env.SUMMARIZER !== 'workers-ai') {
    throw new Error('production requires SUMMARIZER=workers-ai');
  }
  switch (env.SUMMARIZER) {
    case 'workers-ai':
      if (!env.AI) throw new Error('SUMMARIZER=workers-ai needs the AI binding (production only)');
      return new WorkersAISummarizer(env.AI, env.WORKERS_AI_MODEL, env.AI_GATEWAY_ID);
    case 'openai-compatible-local':
      return new OpenAICompatSummarizer(env.LOCAL_LLM_URL, fetcher);
    default:
      return new TemplateSummarizer();
  }
}
