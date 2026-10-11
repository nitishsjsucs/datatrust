import { type ChatMessage, incidentSummaryJsonSchema } from '@datatrust/rca';
import type { Summarizer } from '@datatrust/rca';

type AiRun = (model: string, inputs: unknown, options?: unknown) => Promise<unknown>;

/**
 * Workers AI through AI Gateway (production only; the AI binding is not available in `wrangler dev --local`).
 * JSON mode can fail with "JSON Mode couldn't be met" and does not stream, so failures go to repair, then to
 * the template.
 */
export class WorkersAISummarizer implements Summarizer {
  readonly provider = 'workers-ai' as const;

  constructor(
    private readonly ai: Ai,
    readonly model: string,
    private readonly gatewayId: string,
  ) {}

  async draft(messages: ChatMessage[]): Promise<unknown> {
    const run = (this.ai as unknown as { run: AiRun }).run.bind(this.ai);
    const out = (await run(
      this.model,
      {
        messages,
        response_format: { type: 'json_schema', json_schema: incidentSummaryJsonSchema },
        temperature: 0.1,
        max_tokens: 700,
      },
      { gateway: { id: this.gatewayId, skipCache: false } },
    )) as { response?: unknown } | string;
    if (typeof out === 'string') return out;
    return out?.response ?? out;
  }
}
