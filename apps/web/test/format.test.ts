import { describe, expect, it } from 'vitest';
import { byDistance, isStandIn, pct, shortNode, when } from '../src/format';

describe('display helpers', () => {
  it('shortens node ids', () => {
    expect(shortNode('source.datatrust.raw.hires')).toBe('raw.hires');
    expect(shortNode('model.datatrust.fct_hires')).toBe('fct_hires');
  });

  it('formats numbers and times', () => {
    expect(pct(0.5)).toBe('50%');
    expect(pct(0.0191)).toBe('1.9%');
    expect(when('2026-10-10T17:05:09.123Z')).toBe('2026-10-10 17:05 UTC');
  });

  it('groups the lineage path by hop distance', () => {
    const g = byDistance([
      { node: 'b', distance: 1 },
      { node: 'a', distance: 1 },
      { node: 'x', distance: 0 },
    ]);
    expect(g.map(([d, l]) => [d, l.map((n) => n.node)])).toEqual([
      [0, ['x']],
      [1, ['a', 'b']],
    ]);
  });

  it('labels local stand-ins', () => {
    expect(isStandIn('duckdb (local stand-in for BigQuery)')).toBe(true);
    expect(isStandIn('bigquery')).toBe(false);
  });
});
