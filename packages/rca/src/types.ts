/** Core RCA types shared by the Worker, the offline benchmark CLI and the tests (SPEC 9 to 11). */

/** dbt unique_id, e.g. "model.datatrust.dim_employee" or "source.datatrust.raw.hires". */
export type NodeId = string;

export type Classification = 'pii' | 'identifier' | 'compensation' | 'internal' | 'public';

export interface ColumnRef {
  node: NodeId;
  /** null means "the whole node" (all columns, or a column without column-level lineage). */
  column: string | null;
}

export interface ForeignKeyMeta {
  column: string;
  parent: string;
  parent_column: string;
}

/** Model meta from dbt YAML (`config.meta`); drives probe planning. */
export interface NodeMeta {
  grain?: string[];
  unique_keys?: string[][];
  foreign_keys?: ForeignKeyMeta[];
  interval?: { key: string[]; from: string; to: string };
  timezone?: { ts: string; tz: string; hour?: string; filter_column?: string; filter_value?: string };
  transitions?: { key: string; stage: string; order: string; ts: string };
  fx?: { currency: string; date: string; rate: string };
  casts?: Array<{ column: string; type: string }>;
  recompute?: Array<{ column: string; expr: string }>;
  rowcount?: { parent: string; ratio: number };
  metric?: string;
  [key: string]: unknown;
}

export interface RelationColumn {
  classification: Classification;
  entity?: string | null;
  dataType?: string | null;
}

export interface RelationNode {
  uniqueId: NodeId;
  kind: 'source' | 'model';
  name: string;
  database?: string | null;
  schema: string;
  identifier: string;
  relation?: string | null;
  checksum: string | null;
  materialization: string | null;
  columns: Record<string, RelationColumn>;
  meta: NodeMeta;
}

/** relations.json written by the runner from the dbt manifest. */
export interface RelationsMap {
  project: string;
  dialect: 'duckdb' | 'bigquery';
  nodes: Record<NodeId, RelationNode>;
}

export interface GraphNode {
  kind: 'source' | 'model';
  relation: string;
  columns: string[];
  checksum: string | null;
  classification: Record<string, Classification>;
}

export interface LineageGraph {
  nodes: Record<NodeId, GraphNode>;
  /** From OpenLineage columnLineage facets: input column -> output column. */
  columnEdges: Array<{ from: ColumnRef; to: ColumnRef }>;
  /** From event inputs/outputs plus columnLineage inputFields datasets. */
  datasetEdges: Array<{ from: NodeId; to: NodeId }>;
}

export interface ClosureEntry {
  distance: number;
  /** Columns of the node reached through column-level edges. */
  columns: Set<string>;
  /** True when the node was reached through a dataset-level edge (no column lineage on that path). */
  viaDataset: boolean;
}

export type CheckStatus = 'pass' | 'fail' | 'error' | 'skip';
export type CheckKind = 'data_test' | 'schema_contract' | 'model_error';

/** One check outcome, as produced by the runner from dbt run_results (schemas/api/check_result.json). */
export interface CheckResult {
  checkId: string;
  testName: string;
  category: string;
  kind: CheckKind;
  status: CheckStatus;
  failures: number;
  node: NodeId;
  columns: string[];
  message?: string | null;
  /** Further nodes and columns a singular check reads (registry `also`). */
  also?: Array<{ node: NodeId; columns: string[] }>;
}
