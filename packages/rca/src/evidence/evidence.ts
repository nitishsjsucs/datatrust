/**
 * Sanitized evidence for an incident (SPEC 13.5 step 6, 13.6): failing checks, the top-ranked candidates and
 * the probes that support them, keyed so a summary can cite them with {ev:<key>.<field>} placeholders.
 * Inputs must already be sanitized probe results; `findUnsanitized` re-checks them.
 */
import type { CheckResult, NodeId, ProbeResult, RankedCandidate, RelationsMap } from '../types';
import { findUnsanitized } from './sanitize';

export interface EvidenceCheck {
  key: string;
  checkId: string;
  category: string;
  kind: CheckResult['kind'];
  status: CheckResult['status'];
  failures: number;
  node: NodeId;
  columns: string[];
}

export interface EvidenceProbe {
  key: string;
  probeId: string;
  probe: string;
  node: NodeId;
  columns: string[];
  metric: string;
  value: number;
  anomaly: number;
  sql: string[];
  sampleKeys: ProbeResult['sampleKeys'];
}

export interface EvidenceCandidate {
  key: string;
  rank: number;
  node: NodeId;
  score: number;
  coverage: number;
  ownAnomaly: number;
  changed: number;
  unexplainedPass: number;
  distance: number;
  columns: string[];
  probes: string[];
}

export interface SanitizedEvidence {
  incidentId: string;
  runId: string;
  trigger: 'checks' | 'alert';
  failingChecks: EvidenceCheck[];
  candidates: EvidenceCandidate[];
  probes: EvidenceProbe[];
}

export function shortName(node: NodeId): string {
  const parts = node.split('.');
  return node.startsWith('source.') ? `raw_${parts[parts.length - 1]}` : (parts[parts.length - 1] ?? node);
}

export function checkKey(checkId: string): string {
  return `check.${checkId.toLowerCase().replace(/[^a-z0-9_]+/g, '_')}`;
}

export function probeKey(r: Pick<ProbeResult, 'probe' | 'node' | 'columns'>): string {
  const cols = r.columns.length ? `.${r.columns.join('_')}` : '';
  return `${r.probe}.${shortName(r.node)}${cols}`.replace(/[^A-Za-z0-9_.]/g, '_');
}

export function candidateKey(rank: number): string {
  return `candidate.${rank}`;
}

export interface BuildEvidenceInput {
  incidentId: string;
  runId: string;
  trigger: 'checks' | 'alert';
  checks: CheckResult[];
  ranked: RankedCandidate[];
  probeResults: ProbeResult[];
  relations: RelationsMap;
  topK?: number;
}

export function buildEvidence(input: BuildEvidenceInput): SanitizedEvidence {
  const topK = input.topK ?? 5;
  const top = input.ranked.slice(0, topK);
  const failing = input.checks.filter((c) => c.status === 'fail' || c.status === 'error');
  const wanted = new Set(top.flatMap((c) => c.probes));
  const byId = new Map(input.probeResults.map((r) => [r.probeId, r]));
  const probes: EvidenceProbe[] = [];
  const seenKeys = new Set<string>();
  for (const id of [...wanted].sort()) {
    const r = byId.get(id);
    if (!r) continue;
    let key = probeKey(r);
    for (let i = 2; seenKeys.has(key); i++) key = `${probeKey(r)}_${i}`;
    seenKeys.add(key);
    probes.push({
      key,
      probeId: r.probeId,
      probe: r.probe,
      node: r.node,
      columns: r.columns,
      metric: r.metric,
      value: r.value,
      anomaly: r.anomaly,
      sql: r.sql,
      sampleKeys: r.sampleKeys,
    });
  }
  const violations = findUnsanitized(
    probes.map((p) => ({ ...p, probe: p.probe as ProbeResult['probe'], dialect: '', status: 'ok', details: {} })),
    input.relations,
  );
  if (violations.length > 0) throw new Error(`unsanitized evidence: ${violations[0]!.path} ${violations[0]!.reason}`);
  return {
    incidentId: input.incidentId,
    runId: input.runId,
    trigger: input.trigger,
    failingChecks: failing.map((c) => ({
      key: checkKey(c.checkId),
      checkId: c.checkId,
      category: c.category,
      kind: c.kind,
      status: c.status,
      failures: c.failures,
      node: c.node,
      columns: c.columns,
    })),
    candidates: top.map((c) => ({
      key: candidateKey(c.rank),
      rank: c.rank,
      node: c.node,
      score: c.score,
      coverage: c.features.coverage,
      ownAnomaly: c.features.ownAnomaly,
      changed: c.features.changed,
      unexplainedPass: c.features.unexplainedPass,
      distance: c.features.distance,
      columns: c.columns,
      probes: c.probes.filter((p) => byId.has(p)),
    })),
    probes,
  };
}
