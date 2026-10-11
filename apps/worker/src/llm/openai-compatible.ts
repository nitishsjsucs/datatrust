import type { ChatMessage } from '@datatrust/rca';
import type { Summarizer } from './summarizer';

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
