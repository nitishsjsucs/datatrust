/**
 * Summarizer interface and factory (SPEC 13.6). Commit 12 ships the deterministic template summarizer that
 * the workflows need; the Workers AI and OpenAI-compatible summarizers and the grounding validator follow.
 */
import type { SanitizedEvidence } from '@datatrust/rca';
import type { AppEnv } from '../env';

export interface SummaryOutcome {
  provider: 'workers-ai' | 'openai-compatible-local' | 'template';
  model: string;
  draft: unknown;
  summary: { title: string; impact: string; suspectedRootCause: { node: string; column: string | null }; text: string };
  attempts: number;
  fallback: boolean;
  fallbackReason: string | null;
  prompt: unknown;
}

export interface Summarizer {
  readonly provider: SummaryOutcome['provider'];
  readonly model: string;
  summarize(evidence: SanitizedEvidence): Promise<SummaryOutcome>;
}

export class TemplateSummarizer implements Summarizer {
  readonly provider = 'template' as const;
  readonly model = 'template-v1';

  async summarize(ev: SanitizedEvidence): Promise<SummaryOutcome> {
    const top = ev.candidates[0];
    const checks = ev.failingChecks.map((c) => c.checkId).join(', ');
    const node = top?.node ?? 'unknown';
    const summary = {
      title: `Failing checks ${checks} traced to ${node}`,
      impact: `${ev.failingChecks.length} failing check(s) in run ${ev.runId}.`,
      suspectedRootCause: { node, column: top?.columns[0] ?? null },
      text: top
        ? `Most likely root cause: ${node} (score ${top.score.toFixed(3)}, coverage ${top.coverage.toFixed(2)}).`
        : 'No candidate root cause found.',
    };
    return { provider: this.provider, model: this.model, draft: summary, summary, attempts: 1, fallback: false, fallbackReason: null, prompt: null };
  }
}

export function createSummarizer(env: AppEnv): Summarizer {
  if (env.ENVIRONMENT === 'production' && env.SUMMARIZER !== 'workers-ai') {
    throw new Error('production requires SUMMARIZER=workers-ai');
  }
  return new TemplateSummarizer();
}
