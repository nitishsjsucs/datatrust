/**
 * Grounding validator (SPEC 13.7). A draft passes only if:
 *  1. it matches the IncidentSummary schema;
 *  2. every {ev:key.field} placeholder resolves to an evidence key and field;
 *  3. after removing placeholders and known identifiers (node ids and short names, check ids, evidence keys,
 *     probe ids, column names and sample tokens present in the evidence), no text field contains a digit;
 *  4. suspectedRootCause.node is one of the top 5 ranked candidates;
 *  5. evidenceRefs and diagnosticSqlIds exist in the evidence;
 *  6. no string looks like PII (an email address, a phone number) or an untokenized identifier.
 * Spelled-out small quantities ("top three", "one hour") are fine; bare digits are not.
 */
import type { SanitizedEvidence } from '../evidence/evidence';
import { shortName } from '../evidence/evidence';
import { evidenceFields, PLACEHOLDER, splitPlaceholder } from './render';
import { type IncidentSummary, IncidentSummarySchema } from './schema';

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE_RE = /\+?\d{1,3}[-\s]\d{3}[-\s]\d{3}[-\s]?\d{4}/;
/** An identifier written out with its raw number, e.g. "employee 1042" or "application_id=88". */
const RAW_ID_RE = /\b(employee|candidate|application|hire|emp|cand|app)(_id)?\s*[=:#]?\s*\d+/i;

export interface ValidationResult {
  ok: boolean;
  violations: string[];
  summary: IncidentSummary | null;
}

function knownIdentifiers(ev: SanitizedEvidence): string[] {
  const ids = new Set<string>([ev.incidentId, ev.runId]);
  const addNode = (n: string) => {
    ids.add(n);
    ids.add(shortName(n));
    ids.add(n.split('.').pop() ?? n);
  };
  for (const c of ev.failingChecks) {
    ids.add(c.checkId);
    ids.add(c.key);
    addNode(c.node);
    c.columns.forEach((x) => ids.add(x));
  }
  for (const c of ev.candidates) {
    ids.add(c.key);
    addNode(c.node);
    c.columns.forEach((x) => ids.add(x));
  }
  for (const p of ev.probes) {
    ids.add(p.key);
    ids.add(p.probeId);
    addNode(p.node);
    p.columns.forEach((x) => ids.add(x));
    for (const s of p.sampleKeys) for (const v of Object.values(s)) if (typeof v === 'string') ids.add(v);
  }
  // Longest first, so a full node id is removed before its short name.
  return [...ids].filter((x) => x.length > 0).sort((a, b) => b.length - a.length);
}

function textFields(s: IncidentSummary): Array<[string, string]> {
  return [
    ['title', s.title],
    ['impact', s.impact],
    ...s.reasoning.map((r, i): [string, string] => [`reasoning[${i}]`, r]),
    ...s.nextSteps.map((r, i): [string, string] => [`nextSteps[${i}]`, r]),
  ];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function validateSummary(draft: unknown, ev: SanitizedEvidence): ValidationResult {
  const parsed = IncidentSummarySchema.safeParse(draft);
  if (!parsed.success) {
    return {
      ok: false,
      violations: parsed.error.issues.slice(0, 8).map((i) => `schema: ${i.path.join('.') || '(root)'} ${i.message}`),
      summary: null,
    };
  }
  const s = parsed.data;
  const violations: string[] = [];
  // A model that names the root cause by its candidate key ("candidate.1") means that candidate's node.
  const byKey = ev.candidates.find((c) => c.key === s.suspectedRootCause.node);
  if (byKey) s.suspectedRootCause = { ...s.suspectedRootCause, node: byKey.node };
  const fields = evidenceFields(ev);
  const known = knownIdentifiers(ev);
  const knownRe = known.length ? new RegExp(known.map(escapeRe).join('|'), 'g') : null;

  for (const [where, text] of textFields(s)) {
    for (const m of text.matchAll(PLACEHOLDER)) {
      const parts = splitPlaceholder(m[1]!);
      if (!parts || !fields.get(parts.key)?.has(parts.field)) {
        violations.push(`${where}: unknown placeholder {ev:${m[1]}}`);
      }
    }
    let stripped = text.replace(PLACEHOLDER, ' ');
    if (knownRe) stripped = stripped.replace(knownRe, ' ');
    const digit = stripped.match(/\d+(?:[.,]\d+)?/);
    if (digit) violations.push(`${where}: contains the number "${digit[0]}" outside a placeholder`);
    if (EMAIL_RE.test(text)) violations.push(`${where}: contains an email address`);
    if (PHONE_RE.test(text)) violations.push(`${where}: contains a phone number`);
    if (RAW_ID_RE.test(text.replace(PLACEHOLDER, ' '))) violations.push(`${where}: contains an untokenized identifier`);
  }

  const top5 = ev.candidates.slice(0, 5).map((c) => c.node);
  if (!top5.includes(s.suspectedRootCause.node)) {
    violations.push(`suspectedRootCause.node "${s.suspectedRootCause.node}" is not one of the top five candidates`);
  }
  const keys = new Set(fields.keys());
  for (const ref of s.evidenceRefs) if (!keys.has(ref)) violations.push(`evidenceRefs: unknown key "${ref}"`);
  const sqlIds = new Set(ev.probes.map((p) => p.key));
  for (const id of s.diagnosticSqlIds) if (!sqlIds.has(id)) violations.push(`diagnosticSqlIds: unknown id "${id}"`);
  return { ok: violations.length === 0, violations, summary: s };
}
