/**
 * Summarizers (SPEC 13.6, 13.7). Every provider returns a placeholder draft; the server validates grounding,
 * asks once for a repair that quotes the exact violations, falls back to the deterministic template, and
 * renders {ev:key.field} placeholders itself. The model never writes numbers.
 */
import {
  buildPrompt,
  buildRepairPrompt,
  type ChatMessage,
  type IncidentSummary,
  renderSummary,
  type SanitizedEvidence,
  templateDraft,
  validateSummary,
} from '@datatrust/rca';
import type { AppEnv } from '../env';
import { OpenAICompatSummarizer } from './openai-compatible';
import { TemplateSummarizer } from './template';
import { WorkersAISummarizer } from './workers-ai';

export type ProviderName = 'workers-ai' | 'openai-compatible-local' | 'template';

/** A provider turns chat messages into a raw draft (JSON text or an already-parsed object). */
export interface Summarizer {
  readonly provider: ProviderName;
  readonly model: string;
  draft(messages: ChatMessage[], evidence: SanitizedEvidence): Promise<unknown>;
}

export interface SummaryOutcome {
  provider: ProviderName;
  model: string;
  /** The accepted placeholder draft (or the template draft on fallback). */
  draft: IncidentSummary;
  /** The draft with placeholders rendered from the evidence. */
  summary: IncidentSummary;
  attempts: number;
  firstDraftGrounded: boolean;
  repaired: boolean;
  fallback: boolean;
  fallbackReason: string | null;
  violations: string[];
  prompt: ChatMessage[];
}

function asObject(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function asText(raw: unknown): string {
  return typeof raw === 'string' ? raw : JSON.stringify(raw);
}

export async function summarizeGrounded(s: Summarizer, ev: SanitizedEvidence): Promise<SummaryOutcome> {
  const prompt = buildPrompt(ev);
  let violations: string[] = [];
  let previous = '';
  let calls = 0;
  const maxCalls = s.provider === 'template' ? 1 : 2;
  while (calls < maxCalls) {
    calls += 1;
    let raw: unknown;
    try {
      raw = await s.draft(calls === 1 ? prompt : buildRepairPrompt(ev, previous, violations), ev);
    } catch (err) {
      violations = [`provider error: ${err instanceof Error ? err.name : 'Error'}`];
      break; // a failing provider is not asked again; fall back
    }
    const v = validateSummary(asObject(raw), ev);
    if (v.ok && v.summary) {
      return {
        provider: s.provider,
        model: s.model,
        prompt,
        draft: v.summary,
        summary: renderSummary(v.summary, ev),
        attempts: calls,
        firstDraftGrounded: calls === 1,
        repaired: calls === 2,
        fallback: false,
        fallbackReason: null,
        violations: [],
      };
    }
    violations = v.violations;
    previous = asText(raw);
  }
  const draft = templateDraft(ev);
  return {
    provider: s.provider,
    model: s.model,
    prompt,
    draft,
    summary: renderSummary(draft, ev),
    attempts: calls,
    firstDraftGrounded: false,
    repaired: false,
    fallback: true,
    fallbackReason: violations.slice(0, 3).join('; ') || 'unknown',
    violations,
  };
}

/** Chooses the provider from the SUMMARIZER var. Production refuses anything but Workers AI (SPEC 13.6). */
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
