import { describe, expect, it } from 'vitest';
import { buildLineageGraph } from '../src/lineage/graph';
import { alertAsCheck, checkStartRefs, traceUpstream } from '../src/rca/trace';
import type { CheckResult } from '../src/types';
import { loadEvents, loadRelations } from './helpers';
import { check, FCT, graph, INT_AB, RAW_A, RAW_B, STG_A, STG_B } from './synthetic';

describe('traceUpstream on a synthetic graph', () => {
  it('follows only the failing column upstream in column mode', () => {
    const t = traceUpstream([check('C1', FCT, ['total'])], graph(), 'column');
    expect(t.candidates.map((c) => [c.node, c.distance])).toEqual([
      [FCT, 0],
      [INT_AB, 1],
      [STG_B, 2],
      [RAW_B, 3],
    ]);
    expect(t.failing).toEqual(['C1']);
  });

  it('reaches every upstream node in dataset mode', () => {
    const t = traceUpstream([check('C1', FCT, ['total'])], graph(), 'dataset');
    expect(new Set(t.candidates.map((c) => c.node))).toEqual(new Set([FCT, INT_AB, STG_A, STG_B, RAW_A, RAW_B]));
  });

  it('unions the closures of several failing checks and records which checks reach each node', () => {
    const t = traceUpstream([check('C1', FCT, ['total']), check('C2', STG_A, ['x'])], graph());
    const byNode = Object.fromEntries(t.candidates.map((c) => [c.node, c.checks]));
    expect(byNode[STG_A]).toEqual(['C2']);
    expect(byNode[RAW_A]).toEqual(['C2']);
    expect(byNode[INT_AB]).toEqual(['C1']);
  });

  it('traces a failed metric (an alert) from its node and column like a failing check', () => {
    const alert = alertAsCheck({ metricNode: FCT, column: 'total', observed: 12, expected: 10 });
    expect(alert).toMatchObject({ checkId: 'alert:fct', testName: 'metric_alert', category: 'alert', status: 'fail' });
    const fromAlert = traceUpstream([alert], graph(), 'column');
    const fromCheck = traceUpstream([check('C1', FCT, ['total'])], graph(), 'column');
    expect(fromAlert.candidates.map((c) => [c.node, c.distance])).toEqual(fromCheck.candidates.map((c) => [c.node, c.distance]));
    expect(fromAlert.failing).toEqual(['alert:fct']);
    // Without a column the trace starts at every column of the metric.
    expect(checkStartRefs(alertAsCheck({ metricNode: FCT, observed: 1, expected: 0 }), graph()).length).toBeGreaterThan(1);
  });

  it('ignores passing and skipped checks', () => {
    const t = traceUpstream([check('C1', FCT, ['total'], 'pass'), check('C2', FCT, ['a_id'], 'skip')], graph());
    expect(t.candidates).toEqual([]);
  });

  it('starts a model error at all of the model columns', () => {
    const err: CheckResult = { ...check('E', INT_AB, []), kind: 'model_error', status: 'error' };
    expect(checkStartRefs(err, graph()).map((r) => r.column)).toEqual(['a_id', 'x', 'y']);
  });
});

describe('traceUpstream on the recorded seed-101 lineage', () => {
  const g = buildLineageGraph(loadEvents(), loadRelations());

  it('traces a failed metric reconciliation (X04) to the HRIS source and its transformations', () => {
    const x04: CheckResult = {
      ...check('X04', 'model.datatrust.metric_hires_monthly', ['hires', 'hire_month']),
      also: [
        { node: 'model.datatrust.fct_hires', columns: ['hire_month'] },
        { node: 'model.datatrust.stg_stage_events', columns: ['stage', 'event_local_date'] },
      ],
    };
    const nodes = traceUpstream([x04], g).candidates.map((c) => c.node);
    expect(nodes).toContain('model.datatrust.fct_hires');
    expect(nodes).toContain('model.datatrust.stg_hires');
    expect(nodes).toContain('source.datatrust.raw.hires');
    expect(nodes).toContain('source.datatrust.raw.stage_events');
    expect(nodes).toContain('source.datatrust.raw.locations');
  });

  it('traces a contract failure from its column only', () => {
    const contract: CheckResult = {
      ...check('schema_contract:stg_compensation', 'model.datatrust.stg_compensation', ['base_salary_local_minor']),
      kind: 'schema_contract',
      status: 'error',
    };
    const t = traceUpstream([contract], g);
    expect(t.candidates.map((c) => c.node)).toEqual([
      'model.datatrust.stg_compensation',
      'source.datatrust.raw.compensation',
    ]);
  });
});
