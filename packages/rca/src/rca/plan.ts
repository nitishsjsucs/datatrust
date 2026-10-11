/**
 * Candidates + node meta -> probe requests (SPEC 11 step 2). Planning is metadata-driven and identical for
 * every scenario: each node gets the probes its meta supports, and every candidate's dataset parents are
 * probed too, so the ranker can tell an anomaly a node created from one it inherited.
 */
import { columnParents, datasetParents } from '../lineage/graph';
import type {
  JsonValue,
  LineageGraph,
  NodeId,
  NodeMeta,
  ProbeKind,
  ProbeRequest,
  RelationsMap,
  TraceCandidate,
} from '../types';

/** Row-multiplicity probes: their anomaly propagates to children through joins, whatever the columns. */
export const MULTIPLICITY_PROBES: ReadonlySet<ProbeKind> = new Set([
  'fanout_ratio',
  'rowcount_ratio',
  'dup_key_rate',
  'interval_overlap',
]);

/** Probes whose inheritance is judged per node (dataset parents), not per mapped column. */
export const DATASET_SCOPE_PROBES: ReadonlySet<ProbeKind> = new Set(['fanout_ratio', 'rowcount_ratio']);

/** Resolve a meta parent name: `raw.<table>` is a source, anything else a model. */
export function resolveParent(relations: RelationsMap, name: string): NodeId {
  if (name.includes('.')) return `source.${relations.project}.${name}`;
  return `model.${relations.project}.${name}`;
}

export function probeId(probe: ProbeKind, node: NodeId, columns: string[], extra = ''): string {
  return `${probe}:${node}:${columns.join(',')}${extra ? `:${extra}` : ''}`;
}

function req(
  probe: ProbeKind,
  node: NodeId,
  columns: string[],
  params: Record<string, JsonValue> = {},
  extra = '',
): ProbeRequest {
  return { probeId: probeId(probe, node, columns, extra), probe, node, columns, params };
}

/** Every probe a node's meta supports. */
export function metaProbes(node: NodeId, relations: RelationsMap): ProbeRequest[] {
  const rel = relations.nodes[node];
  if (!rel) return [];
  const m: NodeMeta = rel.meta ?? {};
  const out: ProbeRequest[] = [];
  const isSource = rel.kind === 'source';
  if (m.grain && m.grain.length > 0) {
    out.push(isSource ? req('dup_key_rate', node, m.grain) : req('fanout_ratio', node, m.grain));
  }
  for (const keys of m.unique_keys ?? []) out.push(req('dup_key_rate', node, keys));
  for (const fk of m.foreign_keys ?? []) {
    const parent = resolveParent(relations, fk.parent);
    out.push(
      req('orphan_rate', node, [fk.column], { parent, parent_column: fk.parent_column }, parent),
      req('null_rate', node, [fk.column]),
    );
  }
  if (m.rowcount) {
    const parent = resolveParent(relations, m.rowcount.parent);
    out.push(req('rowcount_ratio', node, [], { parent, ratio: m.rowcount.ratio }));
  }
  if (m.fx) {
    const p = { currency: m.fx.currency, date: m.fx.date, rate: m.fx.rate };
    out.push(
      req('fx_stale_run', node, [m.fx.rate], p),
      req('date_gaps', node, [m.fx.date], { currency: m.fx.currency, date: m.fx.date }),
      req('fx_band_violation', node, [m.fx.rate], p),
    );
  }
  if (m.timezone) {
    const tz = m.timezone as NodeMeta['timezone'] & {
      tz_path?: Array<{ column: string; parent: string; parent_column: string; tz?: string }>;
    };
    const params: Record<string, JsonValue> = { ts: tz.ts };
    if (tz.filter_column) params['filter_column'] = tz.filter_column;
    if (tz.filter_value) params['filter_value'] = tz.filter_value;
    if (tz.tz_path && tz.tz_path.length > 0) {
      params['tz_path'] = tz.tz_path.map((h) => ({
        column: h.column,
        parent: resolveParent(relations, h.parent),
        parent_column: h.parent_column,
        ...(h.tz ? { tz: h.tz } : {}),
      }));
    } else if (tz.tz) {
      params['tz'] = tz.tz;
    }
    out.push(req('tz_hour_profile', node, [tz.ts], params));
  }
  if (m.interval && m.grain && m.grain[0]) {
    const iv = m.interval;
    out.push(
      req('interval_overlap', node, [...iv.key, iv.from, iv.to], {
        key: iv.key,
        from: iv.from,
        to: iv.to,
        id: m.grain[0],
      }),
    );
  }
  if (m.transitions) {
    const t = m.transitions as NodeMeta['transitions'] & { order_map?: Record<string, number> };
    const params: Record<string, JsonValue> = { key: t.key, ts: t.ts };
    if (t.order) params['order'] = t.order;
    else {
      params['stage'] = t.stage;
      params['order_map'] = t.order_map ?? {};
    }
    out.push(req('transition_violation', node, [t.order ?? t.stage], params));
  }
  for (const r of m.recompute ?? []) {
    const rc = r as { column: string; expr: string; compare?: string };
    out.push(req('recompute_delta', node, [rc.column], { expr: rc.expr, compare: rc.compare ?? 'numeric' }));
  }
  for (const c of m.casts ?? []) out.push(req('cast_failure', node, [c.column], { type: c.type }));
  return out;
}

/**
 * Lift a column-scoped probe on `node` to each parent its columns map to through column lineage.
 * Meta-driven kinds use the parent's own meta; key-based kinds reuse the mapped columns.
 */
export function liftToParents(
  probe: ProbeRequest,
  g: LineageGraph,
  relations: RelationsMap,
): ProbeRequest[] {
  if (DATASET_SCOPE_PROBES.has(probe.probe) || probe.columns.length === 0) return [];
  const mapped = new Map<NodeId, string[]>();
  for (const col of probe.columns) {
    for (const p of columnParents(g, probe.node, col)) {
      if (p.column === null) continue;
      const list = mapped.get(p.node) ?? [];
      if (!list.includes(p.column)) list.push(p.column);
      mapped.set(p.node, list);
    }
  }
  const out: ProbeRequest[] = [];
  for (const [parent, cols] of mapped) {
    if (probe.probe === 'dup_key_rate' || probe.probe === 'null_rate') {
      if (cols.length >= probe.columns.length) out.push(req(probe.probe, parent, cols, probe.params));
      continue;
    }
    for (const r of metaProbes(parent, relations)) {
      if (r.probe === probe.probe && r.columns.some((c) => cols.includes(c))) out.push(r);
    }
  }
  return out;
}

export function planProbes(
  candidates: TraceCandidate[],
  g: LineageGraph,
  relations: RelationsMap,
): ProbeRequest[] {
  const nodes = new Set<NodeId>();
  for (const c of candidates) {
    nodes.add(c.node);
    for (const p of datasetParents(g, c.node)) nodes.add(p);
  }
  const byId = new Map<string, ProbeRequest>();
  const add = (r: ProbeRequest) => {
    if (!byId.has(r.probeId) && relations.nodes[r.node]) byId.set(r.probeId, r);
  };
  for (const node of [...nodes].sort()) for (const r of metaProbes(node, relations)) add(r);
  // One more pass so that every column-scoped probe has its parent counterpart.
  for (const r of [...byId.values()]) for (const lifted of liftToParents(r, g, relations)) add(lifted);
  return [...byId.values()].sort((a, b) => a.probeId.localeCompare(b.probeId));
}
