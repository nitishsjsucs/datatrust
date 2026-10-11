import { describe, expect, it } from 'vitest';
import { changeOnly, nearestUpstreamSource, randomInClosure } from '../src/rca/baselines';
import type { FeatureRow } from '../src/rca/rank';

const row = (node: string, kind: 'source' | 'model', distance: number, changed = 0): FeatureRow => ({
  node,
  kind,
  coverage: 1,
  ownAnomaly: 0,
  changed,
  unexplainedPass: 0,
  distance,
  columns: [],
  probes: [],
});

describe('naive baselines', () => {
  const rows = [row('m.fct', 'model', 0), row('m.int', 'model', 1, 1), row('s.b', 'source', 3), row('s.a', 'source', 2)];

  it('change_only puts changed models first, then nearest', () => {
    expect(changeOnly(rows)).toEqual(['m.int', 'm.fct', 's.a', 's.b']);
  });

  it('nearest_upstream_source lists only sources, nearest first', () => {
    expect(nearestUpstreamSource(rows)).toEqual(['s.a', 's.b']);
  });

  it('random_in_closure is min(1, 3/|C|) when the ground truth is a candidate', () => {
    expect(randomInClosure(rows, 's.a')).toBe(0.75);
    expect(randomInClosure(rows, 'missing')).toBe(0);
    expect(randomInClosure(rows.slice(0, 2), 'm.fct')).toBe(1);
  });
});
