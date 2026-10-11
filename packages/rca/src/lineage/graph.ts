/** Lineage graph from OpenLineage events + relations.json, and upstream closure (SPEC 9, 11). */
import type { ClosureEntry, ColumnRef, GraphNode, LineageGraph, NodeId, RelationsMap } from '../types';
import { edgesFromEvent, makeResolver, parseRunEvent, type RunEvent } from './openlineage';
import { compareIds } from '../order';

export function buildLineageGraph(events: Array<RunEvent | unknown>, relations: RelationsMap): LineageGraph {
  const nodes: Record<NodeId, GraphNode> = {};
  for (const n of Object.values(relations.nodes)) {
    const classification: GraphNode['classification'] = {};
    for (const [col, meta] of Object.entries(n.columns)) classification[col] = meta.classification;
    nodes[n.uniqueId] = {
      kind: n.kind,
      relation: `${n.schema}.${n.identifier}`,
      columns: Object.keys(n.columns).sort(),
      checksum: n.checksum,
      classification,
    };
  }
  const resolve = makeResolver(relations);
  const colSeen = new Set<string>();
  const dsSeen = new Set<string>();
  const columnEdges: LineageGraph['columnEdges'] = [];
  const datasetEdges: LineageGraph['datasetEdges'] = [];
  for (const raw of events) {
    const event = parseRunEvent(raw);
    const edges = edgesFromEvent(event, resolve);
    for (const e of edges.columnEdges) {
      const key = `${e.from.node}|${e.from.column}|${e.to.node}|${e.to.column}`;
      if (colSeen.has(key)) continue;
      colSeen.add(key);
      columnEdges.push(e);
    }
    for (const e of edges.datasetEdges) {
      const key = `${e.from}|${e.to}`;
      if (dsSeen.has(key)) continue;
      dsSeen.add(key);
      datasetEdges.push(e);
    }
  }
  const cmpRef = (a: ColumnRef, b: ColumnRef) =>
    compareIds(a.node, b.node) || compareIds(String(a.column), String(b.column));
  columnEdges.sort((a, b) => cmpRef(a.to, b.to) || cmpRef(a.from, b.from));
  datasetEdges.sort((a, b) => compareIds(a.to, b.to) || compareIds(a.from, b.from));
  return { nodes, columnEdges, datasetEdges };
}

interface Indexes {
  colParents: Map<string, ColumnRef[]>;
  dsParents: Map<NodeId, NodeId[]>;
  dsChildren: Map<NodeId, NodeId[]>;
  colChildren: Map<string, ColumnRef[]>;
}

const indexCache = new WeakMap<LineageGraph, Indexes>();

function key(node: NodeId, column: string): string {
  return `${node}\u0000${column}`;
}

function indexes(g: LineageGraph): Indexes {
  const cached = indexCache.get(g);
  if (cached) return cached;
  const colParents = new Map<string, ColumnRef[]>();
  const colChildren = new Map<string, ColumnRef[]>();
  const dsParents = new Map<NodeId, NodeId[]>();
  const dsChildren = new Map<NodeId, NodeId[]>();
  for (const e of g.columnEdges) {
    if (e.to.column === null || e.from.column === null) continue;
    const k = key(e.to.node, e.to.column);
    (colParents.get(k) ?? colParents.set(k, []).get(k)!).push(e.from);
    const kc = key(e.from.node, e.from.column);
    (colChildren.get(kc) ?? colChildren.set(kc, []).get(kc)!).push(e.to);
  }
  for (const e of g.datasetEdges) {
    (dsParents.get(e.to) ?? dsParents.set(e.to, []).get(e.to)!).push(e.from);
    (dsChildren.get(e.from) ?? dsChildren.set(e.from, []).get(e.from)!).push(e.to);
  }
  const idx = { colParents, colChildren, dsParents, dsChildren };
  indexCache.set(g, idx);
  return idx;
}

/** Column-level parents of one column; empty when the column has no column lineage. */
export function columnParents(g: LineageGraph, node: NodeId, column: string): ColumnRef[] {
  return indexes(g).colParents.get(key(node, column)) ?? [];
}

export function columnChildren(g: LineageGraph, node: NodeId, column: string): ColumnRef[] {
  return indexes(g).colChildren.get(key(node, column)) ?? [];
}

export function datasetParents(g: LineageGraph, node: NodeId): NodeId[] {
  return indexes(g).dsParents.get(node) ?? [];
}

export function datasetChildren(g: LineageGraph, node: NodeId): NodeId[] {
  return indexes(g).dsChildren.get(node) ?? [];
}

/**
 * Upstream closure from a set of starting column references.
 * - 'column' mode follows column edges; a column with no column lineage falls back to the dataset
 *   edges of its node (the parents are then reached with viaDataset = true and traced in dataset mode).
 * - 'dataset' mode ignores column edges entirely.
 * The start nodes are included at distance 0. Distances are minimum hop counts.
 */
export function upstreamClosure(
  g: LineageGraph,
  start: ColumnRef[],
  mode: 'column' | 'dataset',
): Map<NodeId, ClosureEntry> {
  const out = new Map<NodeId, ClosureEntry>();
  const entry = (node: NodeId, distance: number): ClosureEntry => {
    let e = out.get(node);
    if (!e) {
      e = { distance, columns: new Set(), viaDataset: false };
      out.set(node, e);
    } else if (distance < e.distance) {
      e.distance = distance;
    }
    return e;
  };
  // Queue items: a column ref (column-level trace) or a node with column null (dataset-level trace).
  const queue: Array<{ ref: ColumnRef; distance: number }> = [];
  const seenCol = new Set<string>();
  const seenNode = new Set<NodeId>();
  const push = (ref: ColumnRef, distance: number) => {
    if (mode === 'dataset' || ref.column === null) {
      const e = entry(ref.node, distance);
      if (distance > 0) e.viaDataset = true;
      if (seenNode.has(ref.node)) return;
      seenNode.add(ref.node);
      queue.push({ ref: { node: ref.node, column: null }, distance });
      return;
    }
    const e = entry(ref.node, distance);
    e.columns.add(ref.column);
    const k = key(ref.node, ref.column);
    if (seenCol.has(k)) return;
    seenCol.add(k);
    queue.push({ ref, distance });
  };
  for (const s of start) push(s, 0);
  // Breadth first: process in distance order so the first visit is the shortest.
  for (let i = 0; i < queue.length; i++) {
    const { ref, distance } = queue[i]!;
    if (ref.column !== null) {
      const parents = columnParents(g, ref.node, ref.column);
      if (parents.length > 0) {
        for (const p of parents) push(p, distance + 1);
        continue;
      }
      // No column lineage for this column: fall back to dataset edges of its node.
      for (const p of datasetParents(g, ref.node)) push({ node: p, column: null }, distance + 1);
      continue;
    }
    for (const p of datasetParents(g, ref.node)) push({ node: p, column: null }, distance + 1);
  }
  return out;
}

/** Share of model columns with at least one incoming column edge (reported by the benchmark). */
export function columnLineageCoverage(g: LineageGraph): { covered: number; total: number; share: number } {
  let covered = 0;
  let total = 0;
  for (const [id, n] of Object.entries(g.nodes)) {
    if (n.kind !== 'model') continue;
    for (const c of n.columns) {
      total++;
      if (columnParents(g, id, c).length > 0) covered++;
    }
  }
  return { covered, total, share: total === 0 ? 0 : covered / total };
}
