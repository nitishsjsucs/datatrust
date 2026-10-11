import { describe, expect, it } from 'vitest';
import {
  buildLineageGraph,
  columnLineageCoverage,
  columnParents,
  datasetParents,
  upstreamClosure,
} from '../src/lineage/graph';
import { edgesFromEvent, makeResolver, parseRunEvent, schemaTable } from '../src/lineage/openlineage';
import { loadEvents, loadRelations } from './helpers';

const M = (name: string) => `model.datatrust.${name}`;
const SRC = (name: string) => `source.datatrust.raw.${name}`;

describe('OpenLineage dataset identity', () => {
  it('drops the database part and keeps (schema, table)', () => {
    expect(schemaTable('warehouse.raw.compensation')).toEqual(['raw', 'compensation']);
    expect(schemaTable('wh2.STAGING.Stg_Hires')).toEqual(['staging', 'stg_hires']);
    expect(schemaTable('my-project.datatrust_marts.dim_employee')).toEqual(['datatrust_marts', 'dim_employee']);
    expect(schemaTable('table_only')).toBeNull();
  });

  it('resolves every qualified dataset in the recorded dbt-ol build', () => {
    const relations = loadRelations();
    const resolve = makeResolver(relations);
    const unresolved = loadEvents().flatMap((e) => edgesFromEvent(parseRunEvent(e), resolve).unresolved);
    // The OpenLineage SQL parser names a CTE as the input of an aggregate it cannot trace
    // (count(*) inside a CTE). Those single-part names are dropped; every real dataset resolves.
    expect(unresolved.every((name) => !name.includes('.'))).toBe(true);
    expect(unresolved.length).toBeLessThanOrEqual(2);
  });
});

describe('buildLineageGraph on the recorded seed-101 build', () => {
  const graph = buildLineageGraph(loadEvents(), loadRelations());

  it('has all 13 sources and 29 models', () => {
    const kinds = Object.values(graph.nodes).map((n) => n.kind);
    expect(kinds.filter((k) => k === 'source')).toHaveLength(13);
    expect(kinds.filter((k) => k === 'model')).toHaveLength(29);
  });

  it('links sources to staging, including multi-input staging models', () => {
    expect(datasetParents(graph, M('stg_hires'))).toEqual([SRC('hires')]);
    expect(new Set(datasetParents(graph, M('stg_stage_events')))).toEqual(
      new Set([SRC('stage_events'), SRC('applications'), SRC('requisitions'), SRC('locations')]),
    );
    for (const [id, n] of Object.entries(graph.nodes)) {
      if (n.kind === 'model') expect(datasetParents(graph, id).length, id).toBeGreaterThan(0);
      else expect(datasetParents(graph, id)).toEqual([]);
    }
  });

  it('records a two-input computed column', () => {
    const parents = columnParents(graph, M('int_compensation_usd'), 'base_salary_usd');
    expect(new Set(parents.map((p) => `${p.node}.${p.column}`))).toEqual(
      new Set([`${M('stg_compensation')}.base_salary_local`, `${M('int_fx_daily')}.rate_to_usd`]),
    );
  });

  it('carries checksums and classifications from relations.json', () => {
    const n = graph.nodes[M('fct_compensation_usd')]!;
    expect(n.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(n.classification['base_salary_usd']).toBe('compensation');
    expect(graph.nodes[M('dim_employee')]!.classification['work_email']).toBe('pii');
  });

  it('is identical when the warehouse path differs (CI runner path rewrite)', () => {
    const rewritten = loadEvents().map((e) =>
      JSON.parse(
        JSON.stringify(e).replaceAll(
          'duckdb:///<scrubbed>',
          'duckdb:///home/runner/work/datatrust/.data/bench/t1/warehouse.duckdb',
        ),
      ),
    );
    expect(JSON.stringify(rewritten)).toContain('/home/runner/work/datatrust');
    expect(buildLineageGraph(rewritten, loadRelations())).toEqual(graph);
  });

  it('has high column-lineage coverage', () => {
    const cov = columnLineageCoverage(graph);
    expect(cov.total).toBeGreaterThan(200);
    expect(cov.share).toBeGreaterThan(0.9);
  });
});

describe('upstreamClosure', () => {
  const graph = buildLineageGraph(loadEvents(), loadRelations());

  it('column mode follows the computed column to both raw inputs, not to join-only parents', () => {
    const c = upstreamClosure(graph, [{ node: M('fct_compensation_usd'), column: 'base_salary_usd' }], 'column');
    expect(c.get(M('fct_compensation_usd'))!.distance).toBe(0);
    expect(c.get(M('int_compensation_usd'))!.columns.has('base_salary_usd')).toBe(true);
    expect(c.get(SRC('compensation'))!.columns.has('base_salary_local_minor')).toBe(true);
    expect(c.get(SRC('fx_rates'))!.columns.has('rate_to_usd')).toBe(true);
    expect(c.has(M('stg_employees'))).toBe(false);
    expect(c.get(SRC('compensation'))!.distance).toBe(3);
  });

  it('dataset mode reaches join-only parents too', () => {
    const c = upstreamClosure(graph, [{ node: M('fct_compensation_usd'), column: 'base_salary_usd' }], 'dataset');
    expect(c.has(M('stg_employees'))).toBe(true);
    expect(c.has(SRC('employees'))).toBe(true);
  });

  it('falls back to dataset edges for a column without column lineage', () => {
    const c = upstreamClosure(graph, [{ node: M('metric_headcount_monthly'), column: 'headcount' }], 'column');
    expect(c.get(M('int_employee_month'))!.viaDataset).toBe(true);
    expect(c.has(SRC('employees'))).toBe(true);
  });
});
