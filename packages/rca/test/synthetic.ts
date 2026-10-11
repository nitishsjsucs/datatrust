/** A small hand-built lineage graph: raw.a -> stg_a -> int_ab <- stg_b <- raw.b ; int_ab -> fct. */
import type { CheckResult, LineageGraph, ProbeResult, RelationsMap } from '../src/types';

export const RAW_A = 'source.p.raw.a';
export const RAW_B = 'source.p.raw.b';
export const STG_A = 'model.p.stg_a';
export const STG_B = 'model.p.stg_b';
export const INT_AB = 'model.p.int_ab';
export const FCT = 'model.p.fct';

const node = (kind: 'source' | 'model', relation: string, columns: string[], checksum: string | null = null) => ({
  kind,
  relation,
  columns,
  checksum,
  classification: Object.fromEntries(columns.map((c) => [c, c.endsWith('_id') ? 'identifier' : 'internal'])) as Record<
    string,
    'identifier' | 'internal'
  >,
});

export function graph(): LineageGraph {
  return {
    nodes: {
      [RAW_A]: node('source', 'raw.a', ['a_id', 'x']),
      [RAW_B]: node('source', 'raw.b', ['b_id', 'a_id', 'y']),
      [STG_A]: node('model', 'staging.stg_a', ['a_id', 'x'], 'ca'),
      [STG_B]: node('model', 'staging.stg_b', ['b_id', 'a_id', 'y'], 'cb'),
      [INT_AB]: node('model', 'staging.int_ab', ['a_id', 'x', 'y'], 'cab'),
      [FCT]: node('model', 'marts.fct', ['a_id', 'total'], 'cf'),
    },
    columnEdges: [
      { from: { node: RAW_A, column: 'a_id' }, to: { node: STG_A, column: 'a_id' } },
      { from: { node: RAW_A, column: 'x' }, to: { node: STG_A, column: 'x' } },
      { from: { node: RAW_B, column: 'b_id' }, to: { node: STG_B, column: 'b_id' } },
      { from: { node: RAW_B, column: 'a_id' }, to: { node: STG_B, column: 'a_id' } },
      { from: { node: RAW_B, column: 'y' }, to: { node: STG_B, column: 'y' } },
      { from: { node: STG_A, column: 'a_id' }, to: { node: INT_AB, column: 'a_id' } },
      { from: { node: STG_A, column: 'x' }, to: { node: INT_AB, column: 'x' } },
      { from: { node: STG_B, column: 'y' }, to: { node: INT_AB, column: 'y' } },
      { from: { node: INT_AB, column: 'a_id' }, to: { node: FCT, column: 'a_id' } },
      { from: { node: INT_AB, column: 'y' }, to: { node: FCT, column: 'total' } },
    ],
    datasetEdges: [
      { from: RAW_A, to: STG_A },
      { from: RAW_B, to: STG_B },
      { from: STG_A, to: INT_AB },
      { from: STG_B, to: INT_AB },
      { from: INT_AB, to: FCT },
    ],
  };
}

export function relations(): RelationsMap {
  const g = graph();
  const nodes: RelationsMap['nodes'] = {};
  for (const [id, n] of Object.entries(g.nodes)) {
    const [schema, identifier] = n.relation.split('.') as [string, string];
    nodes[id] = {
      uniqueId: id,
      kind: n.kind,
      name: identifier,
      schema,
      identifier,
      checksum: n.checksum,
      materialization: n.kind === 'model' ? 'table' : null,
      columns: Object.fromEntries(
        n.columns.map((c) => [c, { classification: n.classification[c]!, entity: c === 'a_id' ? 'emp' : null }]),
      ),
      meta: {},
    };
  }
  nodes[RAW_A]!.meta = { grain: ['a_id'] };
  nodes[STG_A]!.meta = { grain: ['a_id'] };
  nodes[RAW_B]!.meta = { grain: ['b_id'], foreign_keys: [{ column: 'a_id', parent: 'raw.a', parent_column: 'a_id' }] };
  nodes[STG_B]!.meta = { grain: ['b_id'] };
  nodes[INT_AB]!.meta = { grain: ['a_id'], rowcount: { parent: 'stg_a', ratio: 1 } };
  nodes[FCT]!.meta = { grain: ['a_id'], recompute: [{ column: 'total', expr: 'y * 2' }] };
  return { project: 'p', dialect: 'duckdb', nodes };
}

export function check(
  checkId: string,
  node: string,
  columns: string[],
  status: CheckResult['status'] = 'fail',
): CheckResult {
  return { checkId, testName: checkId, category: 'test', kind: 'data_test', status, failures: status === 'fail' ? 1 : 0, node, columns };
}

export function probe(probeId: string, p: ProbeResult['probe'], nodeId: string, columns: string[], anomaly: number): ProbeResult {
  return {
    probeId,
    probe: p,
    node: nodeId,
    columns,
    metric: 'm',
    value: anomaly,
    anomaly,
    sql: ['select 1'],
    dialect: 'duckdb',
    status: 'ok',
    sampleKeys: [],
    details: {},
  };
}
