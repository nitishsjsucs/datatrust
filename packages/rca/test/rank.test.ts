import { describe, expect, it } from 'vitest';
import { metaProbes, planProbes } from '../src/rca/plan';
import { computeFeatures, rankAll, rankCandidates, scoreRows } from '../src/rca/rank';
import { traceUpstream } from '../src/rca/trace';
import { evaluate, leaveOneScenarioOut, tune } from '../src/rca/tune';
import { FROZEN_WEIGHTS, weightGrid } from '../src/rca/weights';
import { check, FCT, graph, INT_AB, probe, RAW_A, RAW_B, relations, STG_A, STG_B } from './synthetic';

describe('own anomaly discounts what a node inherits', () => {
  it('ranks the first anomalous node on the column path first', () => {
    const results = [
      probe('d1', 'dup_key_rate', RAW_B, ['b_id'], 1),
      probe('d2', 'dup_key_rate', STG_B, ['b_id'], 1), // inherited from raw.b through the b_id column edge
    ];
    const ranked = rankCandidates({
      checks: [check('U', STG_B, ['b_id'])],
      graph: graph(),
      probeResults: results,
    });
    expect(ranked[0]!.node).toBe(RAW_B);
    expect(ranked[0]!.features.ownAnomaly).toBe(1);
    const stg = ranked.find((c) => c.node === STG_B)!;
    expect(stg.features.ownAnomaly).toBe(0);
  });

  it('treats row multiplicity as inherited from any dataset parent', () => {
    const results = [
      probe('f1', 'fanout_ratio', INT_AB, ['a_id'], 1),
      probe('f2', 'fanout_ratio', FCT, ['a_id'], 1),
      probe('f3', 'fanout_ratio', STG_A, ['a_id'], 0),
    ];
    const ranked = rankCandidates({
      checks: [check('U', FCT, ['a_id'])],
      graph: graph(),
      probeResults: results,
    });
    expect(ranked.find((c) => c.node === INT_AB)!.features.ownAnomaly).toBe(1);
    expect(ranked.find((c) => c.node === FCT)!.features.ownAnomaly).toBe(0);
    expect(ranked[0]!.node).toBe(INT_AB);
  });

  it('ignores errored probes and evidence-only probes', () => {
    const r1 = { ...probe('e', 'dup_key_rate', RAW_B, ['b_id'], 1), status: 'error' as const };
    const r2 = probe('t', 'delta_vs_last_green', RAW_B, [], 1);
    const rows = computeFeatures({ checks: [check('U', STG_B, ['b_id'])], graph: graph(), probeResults: [r1, r2] });
    expect(rows.every((r) => r.ownAnomaly === 0)).toBe(true);
  });
});

describe('features', () => {
  it('computes coverage, unexplained passes, change signal and distance', () => {
    const rows = computeFeatures({
      checks: [check('F1', FCT, ['total']), check('F2', STG_A, ['x']), check('P1', STG_B, ['y'], 'pass')],
      graph: graph(),
      probeResults: [],
      baselineChecksums: { [INT_AB]: 'old', [FCT]: 'cf', [STG_B]: 'cb' },
    });
    const by = Object.fromEntries(rows.map((r) => [r.node, r]));
    expect(by[FCT]!.coverage).toBe(0.5);
    expect(by[STG_A]!.coverage).toBe(0.5);
    expect(by[INT_AB]!.changed).toBe(1);
    expect(by[FCT]!.changed).toBe(0);
    expect(by[STG_B]!.unexplainedPass).toBe(0.5); // F1 fails through it, P1 passes on it
    expect(by[RAW_B]!.distance).toBe(3);
    expect(by[RAW_A]!.distance).toBe(1);
  });

  it('breaks ties by distance then NodeId', () => {
    const ranked = scoreRows(
      [
        { node: 'b', kind: 'model', coverage: 1, ownAnomaly: 0, changed: 0, unexplainedPass: 0, distance: 1, columns: [], probes: [] },
        { node: 'a', kind: 'model', coverage: 1, ownAnomaly: 0, changed: 0, unexplainedPass: 0, distance: 1, columns: [], probes: [] },
        { node: 'c', kind: 'model', coverage: 1, ownAnomaly: 0, changed: 0, unexplainedPass: 0, distance: 0, columns: [], probes: [] },
      ],
      FROZEN_WEIGHTS,
    );
    expect(ranked.map((r) => r.node)).toEqual(['c', 'a', 'b']);
  });

  it('computes every ablation from one set of probe results', () => {
    const out = rankAll({
      checks: [check('F1', FCT, ['total'])],
      graph: graph(),
      probeResults: [probe('d', 'dup_key_rate', RAW_B, ['b_id'], 1)],
    });
    expect(Object.keys(out.ablations).sort()).toEqual([
      'coverage_only',
      'dataset_lineage_only',
      'no_change_signal',
      'no_probes',
    ]);
    // dataset mode widens the candidate set to stg_a and raw.a
    expect(out.ablations['dataset_lineage_only']).toContain(RAW_A);
    expect(out.ranked.map((c) => c.node)).not.toContain(RAW_A);
  });
});

describe('planProbes', () => {
  it('plans meta probes for candidates and their dataset parents, and lifts column probes to parents', () => {
    const g = graph();
    const rel = relations();
    const t = traceUpstream([check('F1', FCT, ['total'])], g);
    const probes = planProbes(t.candidates, g, rel);
    const ids = probes.map((p) => p.probeId);
    expect(ids).toContain(`fanout_ratio:${INT_AB}:a_id`);
    expect(ids).toContain(`rowcount_ratio:${INT_AB}:`);
    expect(ids).toContain(`recompute_delta:${FCT}:total`);
    expect(ids).toContain(`fanout_ratio:${STG_A}:a_id`); // dataset parent of int_ab, not in the column closure
    expect(ids).toContain(`orphan_rate:${RAW_B}:a_id:source.p.raw.a`);
    expect(new Set(ids).size).toBe(ids.length);
    expect(probes.every((p) => !('sql' in p))).toBe(true);
  });

  it('resolves meta parent names to node ids', () => {
    const rel = relations();
    const rc = metaProbes(INT_AB, rel).find((p) => p.probe === 'rowcount_ratio')!;
    expect(rc.params['parent']).toBe(STG_A);
  });
});

describe('tuning', () => {
  const rowsFor = (gtFirst: boolean) => [
    { node: 'gt', kind: 'source' as const, coverage: 0.5, ownAnomaly: 1, changed: 0, unexplainedPass: 0.5, distance: 2, columns: [], probes: [] },
    { node: 'other', kind: 'model' as const, coverage: 1, ownAnomaly: gtFirst ? 0 : 0, changed: 1, unexplainedPass: 0, distance: 0, columns: [], probes: [] },
  ];
  const trials = [
    { id: 't1', scenario: 'A', groundTruth: 'gt', rows: rowsFor(true) },
    { id: 't2', scenario: 'B', groundTruth: 'other', rows: rowsFor(true) },
  ];

  it('evaluates top-1, top-3 and MRR', () => {
    const e = evaluate(trials, { coverage: 1, anomaly: 0, changed: 0, unexplainedPass: 0 });
    expect(e).toEqual({ n: 2, top1: 0.5, top3: 1, mrr: 0.75 });
  });

  it('picks the grid point with the best top-3, then top-1', () => {
    const best = tune([trials[0]!]);
    expect(best.top1).toBe(1);
    expect(weightGrid().length).toBeGreaterThan(100);
  });

  it('leave-one-scenario-out tunes without the held-out scenario', () => {
    const out = leaveOneScenarioOut(trials, trials);
    expect(Object.keys(out.perScenario).sort()).toEqual(['A', 'B']);
    expect(out.pooled.n).toBe(2);
  });
});
