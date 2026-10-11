/**
 * Candidate scoring and ordering (SPEC 11 steps 3-4).
 *
 *   score = w_cov * coverage + w_anom * own_anomaly + w_chg * changed - w_pass * unexplained_pass
 *
 * coverage          share of failing checks whose column-level closure contains the node
 * own_anomaly       max over the node's probes of (anomaly - the same probe's anomaly on the lineage-mapped
 *                   columns of its parents), clipped to [0, 1]: an inherited anomaly is discounted, so the
 *                   first anomalous node along the column path wins
 * changed           1 if the model's checksum differs from the last green run's manifest
 * unexplained_pass  share of checks downstream of the node (same mapped columns) that pass
 * Ties break by smaller distance to the failing check, then by NodeId.
 */
import { columnParents, datasetParents } from '../lineage/graph';
import type {
  Ablation,
  CheckResult,
  LineageGraph,
  NodeId,
  ProbeResult,
  RankedCandidate,
  RelationsMap,
  Weights,
} from '../types';
import { DATASET_SCOPE_PROBES, MULTIPLICITY_PROBES } from './plan';
import { checkClosure, isFailing } from './trace';
import { FROZEN_WEIGHTS } from './weights';
import { compareIds } from '../order';

export interface FeatureRow {
  node: NodeId;
  kind: 'source' | 'model';
  coverage: number;
  ownAnomaly: number;
  changed: number;
  unexplainedPass: number;
  distance: number;
  columns: string[];
  probes: string[];
}

export interface RankInput {
  checks: CheckResult[];
  graph: LineageGraph;
  relations?: RelationsMap;
  probeResults: ProbeResult[];
  /** Model checksums of the last green run; omitted or null means "no change signal available". */
  baselineChecksums?: Record<NodeId, string | null> | null;
  weights?: Weights;
}

const clip = (x: number) => Math.max(0, Math.min(1, x));

function usable(r: ProbeResult): boolean {
  return r.status === 'ok' && r.probe !== 'delta_vs_last_green' && Number.isFinite(r.anomaly);
}

function resultsByNode(results: ProbeResult[]): Map<NodeId, ProbeResult[]> {
  const out = new Map<NodeId, ProbeResult[]>();
  for (const r of results) {
    if (!usable(r)) continue;
    const list = out.get(r.node) ?? [];
    list.push(r);
    out.set(r.node, list);
  }
  return out;
}

/** The same probe's anomaly on the node's parents (column-mapped, or dataset parents for multiplicity). */
export function parentAnomaly(
  r: ProbeResult,
  g: LineageGraph,
  byNode: Map<NodeId, ProbeResult[]>,
  mode: 'column' | 'dataset',
): number {
  let best = 0;
  const datasetLevel = () => {
    const kinds = DATASET_SCOPE_PROBES.has(r.probe) ? MULTIPLICITY_PROBES : new Set([r.probe]);
    for (const p of datasetParents(g, r.node))
      for (const pr of byNode.get(p) ?? []) if (kinds.has(pr.probe)) best = Math.max(best, pr.anomaly);
    return best;
  };
  if (mode === 'dataset' || DATASET_SCOPE_PROBES.has(r.probe)) return datasetLevel();
  const mapped = new Map<NodeId, Set<string>>();
  for (const col of r.columns) {
    for (const p of columnParents(g, r.node, col)) {
      if (p.column === null) continue;
      const set = mapped.get(p.node) ?? new Set<string>();
      set.add(p.column);
      mapped.set(p.node, set);
    }
  }
  if (mapped.size === 0) return datasetLevel();
  for (const [p, cols] of mapped) {
    for (const pr of byNode.get(p) ?? []) {
      if (pr.probe !== r.probe) continue;
      if (pr.columns.length === 0 || pr.columns.some((c) => cols.has(c))) best = Math.max(best, pr.anomaly);
    }
  }
  return best;
}

export function ownAnomaly(
  node: NodeId,
  g: LineageGraph,
  byNode: Map<NodeId, ProbeResult[]>,
  mode: 'column' | 'dataset',
): { value: number; probes: Array<{ probeId: string; contribution: number }> } {
  const contributions: Array<{ probeId: string; contribution: number }> = [];
  for (const r of byNode.get(node) ?? []) {
    const c = clip(r.anomaly - parentAnomaly(r, g, byNode, mode));
    if (c > 0) contributions.push({ probeId: r.probeId, contribution: c });
  }
  contributions.sort((a, b) => b.contribution - a.contribution || compareIds(a.probeId, b.probeId));
  return { value: contributions[0]?.contribution ?? 0, probes: contributions };
}

/** Features of every candidate (nodes in the union of the failing checks' closures). */
export function computeFeatures(input: RankInput, mode: 'column' | 'dataset' = 'column'): FeatureRow[] {
  const g = input.graph;
  const failing = input.checks.filter(isFailing);
  if (failing.length === 0) return [];
  const passing = input.checks.filter((c) => c.status === 'pass');
  const failingIn = new Map<NodeId, number>();
  const passingIn = new Map<NodeId, number>();
  const distance = new Map<NodeId, number>();
  const columns = new Map<NodeId, Set<string>>();
  for (const check of failing) {
    for (const [node, entry] of checkClosure(check, g, mode)) {
      failingIn.set(node, (failingIn.get(node) ?? 0) + 1);
      distance.set(node, Math.min(distance.get(node) ?? Infinity, entry.distance));
      const set = columns.get(node) ?? new Set<string>();
      for (const c of entry.columns) set.add(c);
      columns.set(node, set);
    }
  }
  for (const check of passing) {
    for (const node of checkClosure(check, g, mode).keys()) {
      if (failingIn.has(node)) passingIn.set(node, (passingIn.get(node) ?? 0) + 1);
    }
  }
  const byNode = resultsByNode(input.probeResults);
  const baseline = input.baselineChecksums ?? null;
  const rows: FeatureRow[] = [];
  for (const [node, nFail] of failingIn) {
    const n = g.nodes[node];
    if (!n) continue;
    const nPass = passingIn.get(node) ?? 0;
    const anomaly = ownAnomaly(node, g, byNode, mode);
    const changed =
      baseline !== null && n.kind === 'model' && node in baseline && baseline[node] !== n.checksum ? 1 : 0;
    rows.push({
      node,
      kind: n.kind,
      coverage: nFail / failing.length,
      ownAnomaly: anomaly.value,
      changed,
      unexplainedPass: nPass / (nFail + nPass),
      distance: distance.get(node) ?? 0,
      columns: [...(columns.get(node) ?? [])].sort(),
      probes: anomaly.probes.map((p) => p.probeId),
    });
  }
  return rows.sort((a, b) => compareIds(a.node, b.node));
}

export function scoreRows(rows: FeatureRow[], weights: Weights, ablation: Ablation = 'full'): RankedCandidate[] {
  let w = weights;
  if (ablation === 'no_probes') w = { ...w, anomaly: 0 };
  if (ablation === 'no_change_signal') w = { ...w, changed: 0 };
  const scored = rows.map((r) => {
    const score =
      ablation === 'coverage_only'
        ? r.coverage
        : w.coverage * r.coverage + w.anomaly * r.ownAnomaly + w.changed * r.changed - w.unexplainedPass * r.unexplainedPass;
    return { r, score: Math.round(score * 1e9) / 1e9 };
  });
  scored.sort((a, b) => b.score - a.score || a.r.distance - b.r.distance || compareIds(a.r.node, b.r.node));
  return scored.map(({ r, score }, i) => ({
    rank: i + 1,
    node: r.node,
    kind: r.kind,
    score,
    features: {
      coverage: r.coverage,
      ownAnomaly: r.ownAnomaly,
      changed: r.changed,
      unexplainedPass: r.unexplainedPass,
      distance: r.distance,
    },
    columns: r.columns,
    probes: r.probes,
  }));
}

export function rankCandidates(input: RankInput): RankedCandidate[] {
  return scoreRows(computeFeatures(input, 'column'), input.weights ?? FROZEN_WEIGHTS, 'full');
}

export const ABLATIONS: Ablation[] = ['coverage_only', 'dataset_lineage_only', 'no_probes', 'no_change_signal'];

export interface RankAllOutput {
  ranked: RankedCandidate[];
  features: { column: FeatureRow[]; dataset: FeatureRow[] };
  ablations: Record<string, NodeId[]>;
}

/** Full ranking plus every ablation, all from the same probe results (no extra dbt cost). */
export function rankAll(input: RankInput): RankAllOutput {
  const weights = input.weights ?? FROZEN_WEIGHTS;
  const column = computeFeatures(input, 'column');
  const dataset = computeFeatures(input, 'dataset');
  const ranked = scoreRows(column, weights, 'full');
  const ablations: Record<string, NodeId[]> = {};
  for (const a of ABLATIONS) {
    ablations[a] = scoreRows(a === 'dataset_lineage_only' ? dataset : column, weights, a).map((c) => c.node);
  }
  return { ranked, features: { column, dataset }, ablations };
}
