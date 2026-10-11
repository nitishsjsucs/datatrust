/** Naive baselines reported next to the ranker (SPEC 11), computed on the same candidate set. */
import type { NodeId } from '../types';
import type { FeatureRow } from './rank';

/** "Blame the last change": changed models first, then nearest, then NodeId. */
export function changeOnly(rows: FeatureRow[]): NodeId[] {
  return [...rows]
    .sort((a, b) => b.changed - a.changed || a.distance - b.distance || a.node.localeCompare(b.node))
    .map((r) => r.node);
}

/** Source nodes in the closure, nearest first. */
export function nearestUpstreamSource(rows: FeatureRow[]): NodeId[] {
  return rows
    .filter((r) => r.kind === 'source')
    .sort((a, b) => a.distance - b.distance || a.node.localeCompare(b.node))
    .map((r) => r.node);
}

/** Expected top-k hit rate of a uniformly random order of the candidate set. */
export function randomInClosure(rows: FeatureRow[], groundTruth: NodeId, k = 3): number {
  if (!rows.some((r) => r.node === groundTruth)) return 0;
  return Math.min(1, k / rows.length);
}

export function baselineOrders(rows: FeatureRow[]): Record<string, NodeId[]> {
  return { change_only: changeOnly(rows), nearest_upstream_source: nearestUpstreamSource(rows) };
}
