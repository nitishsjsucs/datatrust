/** Failing checks and failed metrics -> candidate root-cause nodes (SPEC 11 step 1). */
import { upstreamClosure } from '../lineage/graph';
import type { CheckResult, ClosureEntry, ColumnRef, LineageGraph, NodeId, TraceCandidate } from '../types';

export function isFailing(c: CheckResult): boolean {
  return c.status === 'fail' || c.status === 'error';
}

/** Where the trace starts for one check: its tested node and columns, plus registry `also` targets. */
export function checkStartRefs(check: CheckResult, g: LineageGraph): ColumnRef[] {
  const all = (node: NodeId): ColumnRef[] => {
    const cols = g.nodes[node]?.columns ?? [];
    return cols.length > 0 ? cols.map((column) => ({ node, column })) : [{ node, column: null }];
  };
  const refs: ColumnRef[] = [];
  if (check.kind === 'model_error' || check.columns.length === 0) refs.push(...all(check.node));
  else for (const column of check.columns) refs.push({ node: check.node, column });
  for (const a of check.also ?? []) {
    if (a.columns.length === 0) refs.push(...all(a.node));
    else for (const column of a.columns) refs.push({ node: a.node, column });
  }
  return refs.filter((r) => g.nodes[r.node] !== undefined);
}

export function checkClosure(
  check: CheckResult,
  g: LineageGraph,
  mode: 'column' | 'dataset' = 'column',
): Map<NodeId, ClosureEntry> {
  return upstreamClosure(g, checkStartRefs(check, g), mode);
}

export interface TraceResult {
  candidates: TraceCandidate[];
  failing: string[];
}

export function traceUpstream(
  checks: CheckResult[],
  g: LineageGraph,
  mode: 'column' | 'dataset' = 'column',
): TraceResult {
  const failing = checks.filter(isFailing);
  const acc = new Map<NodeId, TraceCandidate & { colSet: Set<string> }>();
  for (const check of failing) {
    for (const [node, entry] of checkClosure(check, g, mode)) {
      const n = g.nodes[node];
      if (!n) continue;
      let c = acc.get(node);
      if (!c) {
        c = {
          node,
          kind: n.kind,
          distance: entry.distance,
          columns: [],
          viaDataset: entry.viaDataset,
          checks: [],
          colSet: new Set(),
        };
        acc.set(node, c);
      }
      c.distance = Math.min(c.distance, entry.distance);
      c.viaDataset = c.viaDataset && entry.viaDataset;
      for (const col of entry.columns) c.colSet.add(col);
      if (!c.checks.includes(check.checkId)) c.checks.push(check.checkId);
    }
  }
  const candidates = [...acc.values()]
    .map(({ colSet, ...c }) => ({ ...c, columns: [...colSet].sort(), checks: c.checks.sort() }))
    .sort((a, b) => a.distance - b.distance || a.node.localeCompare(b.node));
  return { candidates, failing: failing.map((c) => c.checkId).sort() };
}
