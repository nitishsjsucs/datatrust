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

/** One provider call and its grounding check: a unit the Worker can run as its own Workflow step. */
export interface DraftAttempt {
  /** The provider's answer as text (quoted back in a repair prompt), or null when the call failed. */
  raw: string | null;
  /** Whether the answer parsed as a JSON object. */
  json: boolean;
  ok: boolean;
  draft: IncidentSummary | null;
  violations: string[];
  /** Provider error name; a failing provider is not asked again. */
  error: string | null;
}

/** Messages for call 1 (the prompt) or call 2 (the repair prompt quoting the first answer's violations). */
export function promptFor(ev: SanitizedEvidence, call: 1 | 2, previous: DraftAttempt | null = null): ChatMessage[] {
  return call === 1 ? buildPrompt(ev) : buildRepairPrompt(ev, previous?.raw ?? '', previous?.violations ?? []);
}

export async function attemptDraft(s: Summarizer, messages: ChatMessage[], ev: SanitizedEvidence): Promise<DraftAttempt> {
  let raw: unknown;
  try {
    raw = await s.draft(messages, ev);
  } catch (err) {
    const name = err instanceof Error ? err.name : 'Error';
    return { raw: null, json: false, ok: false, draft: null, violations: [`provider error: ${name}`], error: name };
  }
  const obj = asObject(raw);
  const v = validateSummary(obj, ev);
  return {
    raw: asText(raw),
    json: isJsonObject(obj),
    ok: v.ok && !!v.summary,
    draft: v.ok && v.summary ? v.summary : null,
    violations: v.ok ? [] : v.violations,
    error: null,
  };
}

/** A repair call follows only an LLM draft that answered but failed grounding. */
export function needsRepair(s: Pick<Summarizer, 'provider'>, first: DraftAttempt): boolean {
  return s.provider !== 'template' && !first.ok && first.error === null;
}

/**
 * The outcome of the calls made: the first grounded draft, rendered, or the deterministic template with the
 * reason. `refusal` (for example `daily_neuron_cap`) names why a call was not made at all.
 */
export function finalizeOutcome(
  s: Pick<Summarizer, 'provider' | 'model'>,
  ev: SanitizedEvidence,
  attempts: DraftAttempt[],
  refusal: string | null = null,
): SummaryOutcome {
  const prompt = buildPrompt(ev);
  const firstDraftJson = attempts[0]?.json ?? false;
  const accepted = attempts.findIndex((a) => a.ok && a.draft);
  if (accepted >= 0) {
    const draft = attempts[accepted]!.draft!;
    return {
      provider: s.provider,
      model: s.model,
      prompt,
      draft,
      summary: renderSummary(draft, ev),
      attempts: accepted + 1,
      firstDraftJson,
      firstDraftGrounded: accepted === 0,
      repaired: accepted === 1,
      fallback: false,
      fallbackReason: null,
      violations: [],
    };
  }
  const violations = refusal ? [refusal] : (attempts.at(-1)?.violations ?? []);
  const draft = templateDraft(ev);
  return {
    provider: s.provider,
    model: s.model,
    prompt,
    draft,
    summary: renderSummary(draft, ev),
    attempts: attempts.length,
    firstDraftJson,
    firstDraftGrounded: false,
    repaired: false,
    fallback: true,
    fallbackReason: refusal ?? (violations.slice(0, 3).join('; ') || 'unknown'),
    violations,
  };
}

/** Draft, one repair quoting the violations if needed, then the template fallback (SPEC 13.6, 13.7). */
export async function summarizeGrounded(s: Summarizer, ev: SanitizedEvidence): Promise<SummaryOutcome> {
  const first = await attemptDraft(s, promptFor(ev, 1), ev);
  const attempts = [first];
  if (needsRepair(s, first)) attempts.push(await attemptDraft(s, promptFor(ev, 2, first), ev));
  return finalizeOutcome(s, ev, attempts);
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
