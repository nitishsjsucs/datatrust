/**
 * Placeholders and server-side rendering (SPEC 13.6). The model never writes numbers: it cites
 * {ev:<evidenceKey>.<field>} and the server substitutes the formatted evidence value.
 */
import type { SanitizedEvidence } from '../evidence/evidence';

export const PLACEHOLDER = /\{ev:([A-Za-z0-9_.]+)\}/g;

const RATE_METRICS = new Set([
  'duplicate_row_rate',
  'null_share',
  'orphan_share',
  'share_outside_15pct_of_trailing_median',
  'share_outside_local_business_hours',
  'share_with_backward_transition',
  'recompute_error',
  'cast_failure_share',
]);
const RATIO_METRICS = new Set(['rows_per_grain', 'rowcount_vs_parent', 'overlapping_pairs_per_key']);

export interface EvidenceField {
  value: number;
  format: 'integer' | 'percent' | 'ratio';
}

/** Every citable key -> field -> value, with its display format. */
export function evidenceFields(ev: SanitizedEvidence): Map<string, Map<string, EvidenceField>> {
  const out = new Map<string, Map<string, EvidenceField>>();
  for (const c of ev.failingChecks) out.set(c.key, new Map([['failures', { value: c.failures, format: 'integer' }]]));
  for (const c of ev.candidates) {
    out.set(
      c.key,
      new Map<string, EvidenceField>([
        ['score', { value: c.score, format: 'ratio' }],
        ['coverage', { value: c.coverage, format: 'percent' }],
        ['ownAnomaly', { value: c.ownAnomaly, format: 'ratio' }],
        ['distance', { value: c.distance, format: 'integer' }],
      ]),
    );
  }
  for (const p of ev.probes) {
    const format = RATE_METRICS.has(p.metric) ? 'percent' : RATIO_METRICS.has(p.metric) ? 'ratio' : 'integer';
    out.set(
      p.key,
      new Map<string, EvidenceField>([
        ['value', { value: p.value, format }],
        ['anomaly', { value: p.anomaly, format: 'ratio' }],
      ]),
    );
  }
  return out;
}

export function splitPlaceholder(ref: string): { key: string; field: string } | null {
  const i = ref.lastIndexOf('.');
  if (i <= 0 || i === ref.length - 1) return null;
  return { key: ref.slice(0, i), field: ref.slice(i + 1) };
}

export function formatValue(f: EvidenceField): string {
  if (!Number.isFinite(f.value)) return 'n/a';
  switch (f.format) {
    case 'integer':
      return String(Math.round(f.value));
    case 'percent':
      return `${(f.value * 100).toFixed(1)}%`;
    case 'ratio':
      return f.value.toFixed(3);
  }
}

export function renderText(text: string, fields: Map<string, Map<string, EvidenceField>>): string {
  return text.replace(PLACEHOLDER, (whole, ref: string) => {
    const parts = splitPlaceholder(ref);
    const f = parts ? fields.get(parts.key)?.get(parts.field) : undefined;
    return f ? formatValue(f) : whole;
  });
}

/** Render every text field of a draft summary. Unknown placeholders are left as is (validation rejects them). */
export function renderSummary<T>(draft: T, ev: SanitizedEvidence): T {
  const fields = evidenceFields(ev);
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return renderText(v, fields);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(draft) as T;
}
