/** Deterministic template summarizer (CI, and the fallback when an LLM draft fails grounding twice). */
import type { SanitizedEvidence } from '../evidence/evidence';
import { shortName } from '../evidence/evidence';
import type { IncidentSummary } from './schema';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const CATEGORY_WORDS: Record<string, string> = {
  uniqueness: 'a uniqueness check',
  referential: 'a referential-integrity check',
  interval: 'a historical-interval check',
  stage_transition: 'a recruiting-stage check',
  compensation: 'a compensation or FX check',
  reconciliation: 'a SQL reconciliation',
  schema_contract: 'an enforced schema contract',
  model_error: 'a model build',
  alert: 'a metric alert',
};

export function templateDraft(ev: SanitizedEvidence): IncidentSummary {
  const top = ev.candidates[0];
  const checks = ev.failingChecks;
  const first = checks[0];
  const node = top?.node ?? first?.node ?? 'unknown';
  const name = shortName(node);
  const column = top?.columns[0] ?? null;
  const probe = ev.probes.find((p) => p.node === node) ?? ev.probes[0];
  const reasoning: string[] = [];
  for (const c of checks.slice(0, 2)) {
    reasoning.push(
      `${c.checkId} (${CATEGORY_WORDS[c.category] ?? 'a check'}) failed on ${shortName(c.node)} with {ev:${c.key}.failures} failing rows.`,
    );
  }
  if (top) {
    reasoning.push(
      `Column-level lineage connects ${name} to {ev:${top.key}.coverage} of the failing checks, and it ranks first with score {ev:${top.key}.score}.`,
    );
  }
  if (probe) {
    reasoning.push(
      `The ${probe.probe} probe on ${shortName(probe.node)} measured {ev:${probe.key}.value} (anomaly {ev:${probe.key}.anomaly}), which its parents do not show.`,
    );
  }
  const confidence: IncidentSummary['suspectedRootCause']['confidence'] =
    top && top.ownAnomaly >= 0.9 && top.coverage >= 0.5 ? 'high' : top && top.ownAnomaly > 0 ? 'medium' : 'low';
  return {
    title: `${checks.length === 1 && first ? first.checkId : 'Failing checks'} traced to ${name}`,
    impact: first
      ? `${cap(CATEGORY_WORDS[first.category] ?? 'a check')} on ${shortName(first.node)} failed with {ev:${first.key}.failures} failing rows; downstream marts and metrics built from it are suspect.`
      : 'A failed metric was reported; downstream marts and metrics built from it are suspect.',
    suspectedRootCause: { node, column, confidence },
    reasoning: reasoning.slice(0, 5),
    evidenceRefs: [...checks.slice(0, 3).map((c) => c.key), ...(top ? [top.key] : []), ...(probe ? [probe.key] : [])],
    diagnosticSqlIds: probe ? [probe.key] : [],
    nextSteps: [
      `Run the attached diagnostic SQL against ${name} and inspect the tokenized sample keys.`,
      `Fix the data or the transformation at ${name}, then rerun the validation run.`,
    ],
  };
}
