/**
 * Classification-driven evidence sanitizer (SPEC 13.8, ADR-0007). The same code runs in the runner
 * (`rca sanitize`, before anything is uploaded) and in the Worker (as a check that rejects payloads that
 * still carry raw identifiers).
 *
 * - pii: values never leave the runner; only column names and aggregate rates.
 * - identifier: sample keys become HMAC-SHA256(key, entity + ':' + value) truncated to 10 hex characters
 *   with an entity prefix, e.g. emp_3fa09c1b2e. This is pseudonymization, not anonymization.
 * - compensation: only ratios, percentage errors and counts; absolute amounts are removed.
 * - free-text fields are dropped; error text is reduced to an error class name.
 */
import type { Classification, JsonValue, ProbeResult, RelationsMap } from '../types';

export const TOKEN_RE = /^[a-z]{2,8}_[0-9a-f]{10}$/;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE_RE = /\+?\d{1,3}[-\s]\d{3}[-\s]\d{3}[-\s]?\d{4}/;
const SAFE_TEXT = /^[A-Za-z0-9_./:+ -]{0,64}$/;
/** detail keys whose string values are categorical and public (currency codes, IANA zones, modes). */
const STRING_DETAIL_KEYS = new Set(['currency', 'tz', 'compare', 'type']);

const encoder = new TextEncoder();

async function hmacHex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, encoder.encode(message)));
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function tokenize(key: string, entity: string, value: JsonValue): Promise<string> {
  const hex = await hmacHex(key, `${entity}:${String(value)}`);
  return `${entity}_${hex.slice(0, 10)}`;
}

function entityFor(column: string, explicit?: string | null): string {
  if (explicit && /^[a-z]{2,8}$/.test(explicit)) return explicit;
  const base = column.replace(/_id$/, '').replace(/[^a-z]/g, '');
  return (base.slice(0, 8) || 'key').padEnd(2, 'x');
}

function columnClass(relations: RelationsMap, node: string, column: string): { cls: Classification | null; entity?: string | null } {
  const c = relations.nodes[node]?.columns[column];
  if (!c) return { cls: null };
  return { cls: c.classification, entity: c.entity ?? null };
}

export interface SanitizeOptions {
  key: string;
}

export async function sanitizeProbeResult(
  r: ProbeResult,
  relations: RelationsMap,
  opts: SanitizeOptions,
): Promise<ProbeResult> {
  if (!opts.key || opts.key.length < 16) throw new Error('EVIDENCE_HMAC_KEY must be at least 16 characters');
  const sampleKeys: Array<Record<string, JsonValue>> = [];
  for (const sample of r.sampleKeys.slice(0, 5)) {
    const out: Record<string, JsonValue> = {};
    for (const [col, value] of Object.entries(sample)) {
      if (value === null) {
        out[col] = null;
        continue;
      }
      const { cls, entity } = columnClass(relations, r.node, col);
      if (cls === 'identifier') out[col] = await tokenize(opts.key, entityFor(col, entity), value);
      else if (cls === 'internal' || cls === 'public') {
        if (typeof value === 'number' || typeof value === 'boolean') out[col] = value;
        else if (typeof value === 'string' && SAFE_TEXT.test(value) && !EMAIL_RE.test(value)) out[col] = value;
        // anything else is dropped
      }
      // pii, compensation and unclassified columns: dropped
    }
    if (Object.keys(out).length > 0) sampleKeys.push(out);
  }
  const details: Record<string, JsonValue> = {};
  for (const [k, v] of Object.entries(r.details ?? {})) {
    if (typeof v === 'number' && Number.isFinite(v)) details[k] = v;
    else if (typeof v === 'boolean') details[k] = v;
    else if (typeof v === 'string' && STRING_DETAIL_KEYS.has(k) && SAFE_TEXT.test(v)) details[k] = v;
  }
  const error = r.error && /^[A-Za-z_]{1,64}$/.test(r.error) ? r.error : r.error ? 'Error' : null;
  return {
    probeId: r.probeId,
    probe: r.probe,
    node: r.node,
    columns: [...r.columns],
    metric: r.metric,
    value: Number.isFinite(r.value) ? r.value : 0,
    anomaly: Number.isFinite(r.anomaly) ? r.anomaly : 0,
    sql: r.sql.map((s) => String(s)),
    dialect: r.dialect,
    status: r.status,
    sampleKeys,
    details,
    error,
  };
}

export async function sanitizeProbeResults(
  results: ProbeResult[],
  relations: RelationsMap,
  opts: SanitizeOptions,
): Promise<ProbeResult[]> {
  const out: ProbeResult[] = [];
  for (const r of results) out.push(await sanitizeProbeResult(r, relations, opts));
  return out;
}

export interface Violation {
  probeId: string;
  path: string;
  reason: string;
}

function scanStrings(value: unknown, path: string, visit: (s: string, path: string) => void): void {
  if (typeof value === 'string') visit(value, path);
  else if (Array.isArray(value)) value.forEach((v, i) => scanStrings(v, `${path}[${i}]`, visit));
  else if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) scanStrings(v, `${path}.${k}`, visit);
}

/** Worker-side re-check: any raw identifier, PII-looking string or unexpected text is a violation. */
export function findUnsanitized(results: ProbeResult[], relations: RelationsMap): Violation[] {
  const v: Violation[] = [];
  for (const r of results) {
    r.sampleKeys.forEach((sample, i) => {
      for (const [col, value] of Object.entries(sample)) {
        if (value === null) continue;
        const { cls } = columnClass(relations, r.node, col);
        const path = `sampleKeys[${i}].${col}`;
        if (cls === null || cls === 'pii' || cls === 'compensation')
          v.push({ probeId: r.probeId, path, reason: `column class ${cls ?? 'unknown'} must not be sampled` });
        else if (cls === 'identifier' && !(typeof value === 'string' && TOKEN_RE.test(value)))
          v.push({ probeId: r.probeId, path, reason: 'identifier is not an HMAC token' });
      }
    });
    for (const [k, val] of Object.entries(r.details ?? {})) {
      if (typeof val === 'string' && !STRING_DETAIL_KEYS.has(k))
        v.push({ probeId: r.probeId, path: `details.${k}`, reason: 'free text detail' });
    }
    if (r.error && !/^[A-Za-z_]{1,64}$/.test(r.error))
      v.push({ probeId: r.probeId, path: 'error', reason: 'free text error' });
    scanStrings({ sampleKeys: r.sampleKeys, details: r.details }, '', (s, path) => {
      if (EMAIL_RE.test(s)) v.push({ probeId: r.probeId, path, reason: 'email address' });
      if (PHONE_RE.test(s)) v.push({ probeId: r.probeId, path, reason: 'phone number' });
    });
  }
  return v;
}
