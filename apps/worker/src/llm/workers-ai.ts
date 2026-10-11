import { type ChatMessage, incidentSummaryJsonSchema } from '@datatrust/rca';
import type { Summarizer } from '@datatrust/rca';
import { MAX_OUTPUT_TOKENS, type TokenUsage } from './budget';

type AiRun = (model: string, inputs: unknown, options?: unknown) => Promise<unknown>;

/** The summary schema for JSON mode, without the `$schema` meta key (the docs' examples pass a bare schema). */
const { $schema: _meta, ...summarySchema } = incidentSummaryJsonSchema;
/** Characters of the schema sent with every call, counted in the neuron reservation (SPEC 28.5.5). */
export const SUMMARY_SCHEMA_CHARS = JSON.stringify(summarySchema).length;

/**
 * Workers AI through AI Gateway (production only; the AI binding is not available in `wrangler dev --local`).
 * JSON mode can fail with "JSON Mode couldn't be met" and does not stream, so failures go to repair, then to
 * the template.
 */
export class WorkersAISummarizer implements Summarizer {
  readonly provider = 'workers-ai' as const;
  /** Token usage of the last call, when the response reports it (settles the neuron ledger). */
  lastUsage: TokenUsage | null = null;

  constructor(
    private readonly ai: Ai,
    readonly model: string,
    private readonly gatewayId: string,
  ) {}

  async draft(messages: ChatMessage[]): Promise<unknown> {
    this.lastUsage = null;
    const run = (this.ai as unknown as { run: AiRun }).run.bind(this.ai);
    const out = (await run(
      this.model,
      {
        messages,
        response_format: { type: 'json_schema', json_schema: summarySchema },
        temperature: 0.1,
        max_tokens: MAX_OUTPUT_TOKENS,
      },
      { gateway: { id: this.gatewayId, skipCache: false } },
    )) as { response?: unknown; usage?: TokenUsage } | string;
    this.lastUsage = typeof out === 'object' && out ? (out.usage ?? null) : null;
    if (typeof out === 'string') return out;
    return out?.response ?? out;
  }
}
