/**
 * The Worker's environment. Generated with `wrangler types --strict-vars=false`, then narrowed: vars become
 * unions (so `ENVIRONMENT === 'production'` type-checks), and the production-only bindings are optional
 * because the local configuration has no AI or Pipelines binding (SPEC 13.10, review finding B4).
 */
export type Environment = 'local' | 'production';
export type SummarizerKind = 'template' | 'openai-compatible-local' | 'workers-ai';
export type AccessMode = 'local-jwks' | 'cloudflare';

export interface PipelineStream {
  send(records: object[]): Promise<void>;
}

export interface AppEnv extends Omit<Env, 'ENVIRONMENT' | 'SUMMARIZER' | 'ACCESS_MODE' | 'ACCESS_JWKS_JSON'> {
  ENVIRONMENT: Environment;
  SUMMARIZER: SummarizerKind;
  ACCESS_MODE: AccessMode;
  /** Local only: the JWKS written by `npm run dev:keys`. */
  ACCESS_JWKS_JSON?: string;
  /** Present only in production (Workers AI through AI Gateway). */
  AI?: Ai;
  /** Present only in production (Basin Pipelines stream binding). */
  EVENTS?: PipelineStream;
}

/** Production must run with Cloudflare Access, Workers AI and the Pipelines stream, never a stand-in. */
export function misconfiguration(env: AppEnv): string | null {
  if (env.ENVIRONMENT !== 'production') return null;
  if (env.ACCESS_MODE !== 'cloudflare') return 'ACCESS_MODE must be cloudflare in production';
  if (env.SUMMARIZER !== 'workers-ai') return 'SUMMARIZER must be workers-ai in production';
  if (!env.AI) return 'AI binding missing in production';
  if (!env.EVENTS) return 'EVENTS (Pipelines) binding missing in production';
  return null;
}
