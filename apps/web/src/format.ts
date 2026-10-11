/** Pure display helpers (unit-tested). */
export function shortNode(node: string): string {
  const parts = node.split('.');
  const name = parts[parts.length - 1] ?? node;
  return node.startsWith('source.') ? `raw.${name}` : name;
}

export function pct(x: number): string {
  return `${Math.round(x * 1000) / 10}%`;
}

export function score(x: number): string {
  return x.toFixed(3);
}

export function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

/** Group lineage-path nodes by hop distance from the failing checks (0 = tested node). */
export function byDistance<T extends { distance: number; node: string }>(nodes: T[]): Array<[number, T[]]> {
  const groups = new Map<number, T[]>();
  for (const n of nodes) groups.set(n.distance, [...(groups.get(n.distance) ?? []), n]);
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([d, list]) => [d, [...list].sort((a, b) => a.node.localeCompare(b.node))]);
}

/** Stand-ins are labelled as such everywhere (ADR-0003). */
export function isStandIn(value: unknown): boolean {
  return typeof value === 'string' && /stand-in|template|local/i.test(value);
}

/** Time-travel evidence from provenance: row counts now vs the last green run (evidence only, never ranked). */
export function timeTravelText(tt: unknown): string {
  const t = (tt ?? {}) as { lastGreenRunId?: string | null; nodes?: Array<{ node: string; rowsNow?: unknown; rowsThen?: unknown }> };
  if (!t.lastGreenRunId) return 'no earlier green run of this target';
  const nodes = t.nodes ?? [];
  if (nodes.length === 0) return `no snapshot or history available vs ${t.lastGreenRunId}`;
  const parts = nodes.map((n) => `${shortNode(n.node)} ${String(n.rowsThen ?? '?')} to ${String(n.rowsNow ?? '?')} rows`);
  return `vs ${t.lastGreenRunId}: ${parts.join('; ')}`;
}
