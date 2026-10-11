/**
 * The Worker's environment. Generated with `wrangler types --strict-vars=false`, then narrowed: vars become
 * unions (so `ENVIRONMENT === 'production'` type-checks), and the production-only AI binding is optional
 * because the local configuration has none (SPEC 13.10, review finding B4). Production runs on the Workers
 * Free plan, so no Paid-only binding exists in either configuration (SPEC 28, ADR-0008).
 */
import { dailyCap, neuronRate } from './llm/budget';

export type Environment = 'local' | 'production';
export type SummarizerKind = 'template' | 'openai-compatible-local' | 'workers-ai';
export type AccessMode = 'local-jwks' | 'cloudflare';

export interface AppEnv extends Omit<Env, 'ENVIRONMENT' | 'SUMMARIZER' | 'ACCESS_MODE' | 'ACCESS_JWKS_JSON'> {
  ENVIRONMENT: Environment;
  SUMMARIZER: SummarizerKind;
  ACCESS_MODE: AccessMode;
  /** Local only: the JWKS written by `npm run dev:keys`. */
  ACCESS_JWKS_JSON?: string;
  /** Present only in production (Workers AI through AI Gateway). */
  AI?: Ai;
}

/**
 * Production must run with Cloudflare Access, Workers AI with a pinned neuron rate and a numeric daily cap,
 * and the audit queue, never a stand-in (SPEC 13.10, 28.5.8).
 */
export function misconfiguration(env: AppEnv): string | null {
  if (env.ENVIRONMENT !== 'production') return null;
  if (env.ACCESS_MODE !== 'cloudflare') return 'ACCESS_MODE must be cloudflare in production';
  if (env.SUMMARIZER !== 'workers-ai') return 'SUMMARIZER must be workers-ai in production';
  if (!env.AI) return 'AI binding missing in production';
  if (!env.AUDIT_Q) return 'AUDIT_Q (datatrust-audit-events) binding missing in production';
  if (!neuronRate(env.WORKERS_AI_MODEL)) return `WORKERS_AI_MODEL ${env.WORKERS_AI_MODEL} has no pinned neuron rate`;
  if (dailyCap(env.AI_DAILY_NEURON_CAP) === null) return 'AI_DAILY_NEURON_CAP must be a positive integer';
  return null;
}
