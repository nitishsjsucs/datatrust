/**
 * Workers AI on the Free plan (SPEC 28.5.5): 10,000 neurons per account per UTC day and no overage, shared
 * by four repos. DataTrust caps itself with a D1 ledger at AI_DAILY_NEURON_CAP (2,000 in production) and
 * reserves each call's worst case before making it.
 */

/** Neurons per million tokens (Workers AI pricing page, 2026-10-10). A model without a rate is refused. */
export const NEURON_RATES: Readonly<Record<string, { inputPerM: number; outputPerM: number }>> = {
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast': { inputPerM: 26_668, outputPerM: 204_805 },
};

/** Models that need Workers Paid billing (403 on Free); none is used, and the production config may not. */
export const PAID_ONLY_MODELS: readonly string[] = [
  '@cf/moonshotai/kimi-k2.6',
  '@cf/moonshotai/kimi-k2.7-code',
  '@cf/zai-org/glm-5.2',
  '@cf/zai-org/glm-5.3',
  '@cf/zai-org/glm-5.3-flash',
  '@cf/deepseek-ai/deepseek-v4-flash-0731',
  '@cf/deepseek-ai/deepseek-v4-pro-0813',
];

export const MAX_OUTPUT_TOKENS = 700;
/** Conservative characters per input token for the reservation (the tokenizer is not available here). */
export const CHARS_PER_TOKEN = 3;

export type NeuronRate = { inputPerM: number; outputPerM: number };

export function neuronRate(model: string): NeuronRate | null {
  return NEURON_RATES[model] ?? null;
}

/** Worst case of one call: every input character a third of a token, and the full output budget. */
export function reservationNeurons(promptChars: number, schemaChars: number, rate: NeuronRate, maxTokens = MAX_OUTPUT_TOKENS): number {
  const inputTokens = Math.ceil((promptChars + schemaChars) / CHARS_PER_TOKEN);
  return Math.ceil((inputTokens * rate.inputPerM) / 1e6 + (maxTokens * rate.outputPerM) / 1e6);
}

export interface TokenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

/** Neurons of a finished call from the response's token usage, or null when the response reports none. */
export function usageNeurons(usage: TokenUsage | null | undefined, rate: NeuronRate): number | null {
  if (!usage || typeof usage.prompt_tokens !== 'number' || typeof usage.completion_tokens !== 'number') return null;
  return Math.ceil((usage.prompt_tokens * rate.inputPerM) / 1e6 + (usage.completion_tokens * rate.outputPerM) / 1e6);
}

/** The ledger key: the UTC date, because the allowance resets at 00:00 UTC. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function dailyCap(value: string | undefined): number | null {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Reserve `cost` neurons for `day` with ONE conditional upsert: it succeeds only while reserved + cost stays
 * within the cap, so concurrent investigations can never overshoot it together.
 */
export async function reserveNeurons(db: D1Database, day: string, cost: number, cap: number): Promise<boolean> {
  const row = await db
    .prepare(
      `INSERT INTO ai_budget (day, reserved, used, calls) SELECT ?1, ?2, 0, 1 WHERE ?2 <= ?3
       ON CONFLICT (day) DO UPDATE SET reserved = reserved + excluded.reserved, calls = calls + 1
         WHERE ai_budget.reserved + excluded.reserved <= ?3
       RETURNING reserved`,
    )
    .bind(day, cost, cap)
    .first<{ reserved: number }>();
  return row !== null;
}

/** Replace a reservation with what the call used (or keep it when usage is unknown) and add it to `used`. */
export async function settleNeurons(db: D1Database, day: string, reserved: number, used: number): Promise<void> {
  await db
    .prepare(`UPDATE ai_budget SET reserved = reserved - ?2 + ?3, used = used + ?3 WHERE day = ?1`)
    .bind(day, reserved, used)
    .run();
}

export interface BudgetStatus {
  day: string;
  cap: number;
  reserved: number;
  used: number;
  calls: number;
  headroom: number;
}

export async function budgetStatus(db: D1Database, day: string, cap: number): Promise<BudgetStatus> {
  const row = await db
    .prepare(`SELECT reserved, used, calls FROM ai_budget WHERE day = ?`)
    .bind(day)
    .first<{ reserved: number; used: number; calls: number }>();
  const reserved = row?.reserved ?? 0;
  return { day, cap, reserved, used: row?.used ?? 0, calls: row?.calls ?? 0, headroom: Math.max(0, cap - reserved) };
}
