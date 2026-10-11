/**
 * The grounded summarization loop and the portable providers (SPEC 13.6, 13.7), shared by the Worker and the
 * offline summary eval (`rca summarize`), so both measure the same code (ADR-0002).
 *
 * Every provider returns a placeholder draft; the loop validates grounding, asks once for a repair that
 * quotes the exact violations, falls back to the deterministic template, and renders {ev:key.field}
 * placeholders itself. The model never writes numbers.
 */
import type { SanitizedEvidence } from '../evidence/evidence';
import { buildPrompt, buildRepairPrompt, type ChatMessage } from './prompt';
import { renderSummary } from './render';
import type { IncidentSummary } from './schema';
import { templateDraft } from './template';
import { validateSummary } from './validate';

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
  /** Whether the provider's first answer parsed as a JSON object. */
  firstDraftJson: boolean;
  firstDraftGrounded: boolean;
  repaired: boolean;
  fallback: boolean;
  fallbackReason: string | null;
  violations: string[];
  prompt: ChatMessage[];
}

export function asObject(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  const text = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function asText(raw: unknown): string {
  return typeof raw === 'string' ? raw : JSON.stringify(raw);
}

function isJsonObject(v: unknown): boolean {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export async function summarizeGrounded(s: Summarizer, ev: SanitizedEvidence): Promise<SummaryOutcome> {
  const prompt = buildPrompt(ev);
  let violations: string[] = [];
  let previous = '';
  let calls = 0;
  let firstDraftJson = false;
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
    const obj = asObject(raw);
    if (calls === 1) firstDraftJson = isJsonObject(obj);
    const v = validateSummary(obj, ev);
    if (v.ok && v.summary) {
      return {
        provider: s.provider,
        model: s.model,
        prompt,
        draft: v.summary,
        summary: renderSummary(v.summary, ev),
        attempts: calls,
        firstDraftJson,
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
    firstDraftJson,
    firstDraftGrounded: false,
    repaired: false,
    fallback: true,
    fallbackReason: violations.slice(0, 3).join('; ') || 'unknown',
    violations,
  };
}

/** Deterministic template (CI, and the fallback for LLM drafts that fail grounding). */
export class TemplateSummarizer implements Summarizer {
  readonly provider = 'template' as const;
  readonly model = 'template-v1';

  async draft(_messages: ChatMessage[], evidence: SanitizedEvidence): Promise<unknown> {
    return templateDraft(evidence);
  }
}

/**
 * Local stand-in for Workers AI: an OpenAI-compatible server (llama-server with Qwen3-1.7B on 127.0.0.1:8160).
 * Thinking is disabled and decoding is deterministic.
 */
export class OpenAICompatSummarizer implements Summarizer {
  readonly provider = 'openai-compatible-local' as const;
  readonly model = 'qwen3-1.7b-q4_0 (llama-server)';

  constructor(
    private readonly baseUrl: string,
    // Wrapped: calling the global fetch as a method of another object throws "Illegal invocation" in workerd.
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  async draft(messages: ChatMessage[]): Promise<unknown> {
    const res = await this.fetcher(`${this.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'local',
        messages,
        response_format: { type: 'json_object' },
        chat_template_kwargs: { enable_thinking: false },
        temperature: 0,
        seed: 7,
        max_tokens: 700,
      }),
    });
    if (!res.ok) throw new Error(`local LLM returned ${res.status}`);
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('local LLM returned no content');
    return content;
  }
}
