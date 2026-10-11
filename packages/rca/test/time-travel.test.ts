import { describe, expect, it } from 'vitest';
import { planTimeTravelProbes } from '../src/rca/plan';
import type { RelationsMap, TraceCandidate } from '../src/types';
import { loadRelations } from './helpers';

const cand = (node: string): TraceCandidate => ({
  node,
  kind: node.startsWith('source.') ? 'source' : 'model',
  distance: 0,
  columns: [],
  viaDataset: false,
  checks: ['U05'],
});

const NODES = [
  'source.datatrust.raw.hires',
  'model.datatrust.stg_hires',
  'model.datatrust.int_compensation_usd',
  'model.datatrust.fct_hires',
  'model.datatrust.metric_hires_monthly',
];
const GREEN = { runId: 'run_01GREEN', finishedAtMs: 1_760_000_000_000 };

describe('planTimeTravelProbes (delta_vs_last_green, evidence only)', () => {
  it('plans nothing without a last green run', () => {
    expect(planTimeTravelProbes(NODES.map(cand), loadRelations(), null)).toEqual([]);
  });

  it('DuckDB stand-in: only mart tables, which the runner snapshots after green runs', () => {
    const rel = loadRelations();
    const probes = planTimeTravelProbes(NODES.map(cand), rel, GREEN);
    expect(probes.map((p) => p.node)).toEqual(['model.datatrust.fct_hires', 'model.datatrust.metric_hires_monthly']);
    for (const p of probes) {
      expect(p.probe).toBe('delta_vs_last_green');
      expect(p.params).toEqual({ lastGreenRunId: 'run_01GREEN', lastGreenFinishedAtMs: GREEN.finishedAtMs });
    }
  });

  it('BigQuery: sources and table materializations, never views', () => {
    const local = loadRelations();
    const bq: RelationsMap = { ...local, dialect: 'bigquery' };
    const nodes = planTimeTravelProbes(NODES.map(cand), bq, GREEN).map((p) => p.node);
    expect(nodes).toContain('source.datatrust.raw.hires');
    expect(nodes).toContain('model.datatrust.int_compensation_usd');
    expect(nodes).toContain('model.datatrust.fct_hires');
    expect(nodes).not.toContain('model.datatrust.stg_hires'); // staging models are views
  });
});
