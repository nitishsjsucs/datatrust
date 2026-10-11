/**
 * The summary as three Workflow steps (SPEC 13.5, 28.5.5): `summarize-draft` (AI call 1), `summarize-repair`
 * (AI call 2, only when the first draft failed grounding) and `summarize-finalize` (no AI call). Each AI call
 * is its own step, so a later failure replays the stored result instead of calling Workers AI again. Before a
 * Workers AI call the step reserves the call's worst case in the daily neuron ledger; when the reservation
 * is refused, no call is made and the incident gets the template with reason `daily_neuron_cap`.
 */
import {
  attemptDraft,
  type DraftAttempt,
  finalizeOutcome,
  needsRepair,
  promptFor,
  type SanitizedEvidence,
  type Summarizer,
  type SummaryOutcome,
} from '@datatrust/rca';
import type { AppEnv } from '../env';
import { dailyCap, neuronRate, reservationNeurons, reserveNeurons, settleNeurons, usageNeurons, utcDay } from './budget';
import { SUMMARY_SCHEMA_CHARS } from './workers-ai';

export const DAILY_NEURON_CAP_REASON = 'daily_neuron_cap';

export interface LedgeredAttempt extends DraftAttempt {
  /** True when the ledger refused the reservation, so no call was made. */
  refused: boolean;
  reservedNeurons: number;
  /** Neurons from the response's token usage, or null when not reported (the reservation then stands). */
  usedNeurons: number | null;
}

const usageOf = (s: Summarizer) => (s as { lastUsage?: { prompt_tokens?: number; completion_tokens?: number } | null }).lastUsage;

export async function summarizeAttempt(
  env: AppEnv,
  s: Summarizer,
  ev: SanitizedEvidence,
  call: 1 | 2,
  previous: DraftAttempt | null,
  now: Date = new Date(),
): Promise<LedgeredAttempt> {
  const messages = promptFor(ev, call, previous);
  if (s.provider !== 'workers-ai') {
    return { ...(await attemptDraft(s, messages, ev)), refused: false, reservedNeurons: 0, usedNeurons: null };
  }
  const rate = neuronRate(s.model);
  const cap = dailyCap(env.AI_DAILY_NEURON_CAP);
  if (!rate || cap === null) throw new Error('Workers AI needs a pinned neuron rate and AI_DAILY_NEURON_CAP');
  const chars = messages.reduce((n, m) => n + m.content.length, 0);
  const cost = reservationNeurons(chars, SUMMARY_SCHEMA_CHARS, rate);
  const day = utcDay(now);
  if (!(await reserveNeurons(env.DB, day, cost, cap))) {
    return {
      raw: null,
      json: false,
      ok: false,
      draft: null,
      violations: [DAILY_NEURON_CAP_REASON],
      error: null,
      refused: true,
      reservedNeurons: 0,
      usedNeurons: null,
    };
  }
  const attempt = await attemptDraft(s, messages, ev);
  const used = usageNeurons(usageOf(s), rate);
  try {
    await settleNeurons(env.DB, day, cost, used ?? cost);
  } catch (err) {
    // The reservation stands (it is the worst case); throwing here would retry the step and call AI again.
    console.error('neuron ledger settlement failed', err);
  }
  return { ...attempt, refused: false, reservedNeurons: cost, usedNeurons: used };
}

export function shouldRepair(s: Summarizer, first: LedgeredAttempt): boolean {
  return !first.refused && needsRepair(s, first);
}

export interface FinalSummary extends SummaryOutcome {
  neurons: { reserved: number; used: number | null };
}

export function finalizeSummary(
  s: Summarizer,
  ev: SanitizedEvidence,
  first: LedgeredAttempt,
  second: LedgeredAttempt | null,
): FinalSummary {
  const made = [first, second].filter((a): a is LedgeredAttempt => !!a && !a.refused);
  const refused = first.refused || !!second?.refused;
  const outcome = finalizeOutcome(s, ev, made, refused && !made.some((a) => a.ok) ? DAILY_NEURON_CAP_REASON : null);
  const reserved = made.reduce((n, a) => n + a.reservedNeurons, 0);
  const usedKnown = made.every((a) => a.usedNeurons !== null);
  return {
    ...outcome,
    neurons: { reserved, used: made.length && usedKnown ? made.reduce((n, a) => n + (a.usedNeurons ?? 0), 0) : null },
  };
}
