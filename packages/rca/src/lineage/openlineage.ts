/**
 * OpenLineage RunEvent parsing (zod) and event -> edge extraction (SPEC 9).
 *
 * Dataset identity: OpenLineage namespaces from dbt-ol on DuckDB embed the absolute warehouse path
 * (`duckdb:///home/runner/.../warehouse.duckdb`) and names are `<file stem>.<schema>.<table>`. Neither is
 * stable across machines, so the resolver ignores the namespace, drops the leading database part of the
 * name and matches (schema, table), case-folded, against relations.json. BigQuery names
 * (`project.dataset.table`) resolve the same way on (dataset, table).
 */
import { z } from 'zod';
import type { ColumnRef, NodeId, RelationsMap } from '../types';

const InputField = z.looseObject({
  namespace: z.string(),
  name: z.string(),
  field: z.string(),
});

const ColumnLineageFacet = z.looseObject({
  fields: z.record(
    z.string(),
    z.looseObject({
      inputFields: z.array(InputField).default([]),
    }),
  ),
});

const Dataset = z.looseObject({
  namespace: z.string(),
  name: z.string(),
  facets: z
    .looseObject({
      columnLineage: ColumnLineageFacet.optional(),
    })
    .optional(),
});

export const RunEventSchema = z.looseObject({
  eventType: z.string().optional(),
  eventTime: z.string(),
  producer: z.string().optional(),
  run: z.looseObject({ runId: z.string() }),
  job: z.looseObject({ namespace: z.string(), name: z.string() }),
  inputs: z.array(Dataset).default([]),
  outputs: z.array(Dataset).default([]),
});

export type RunEvent = z.infer<typeof RunEventSchema>;

export function parseRunEvent(value: unknown): RunEvent {
  return RunEventSchema.parse(value);
}

/** Split an OpenLineage dataset name into its last two parts: (schema, table). */
export function schemaTable(name: string): [string, string] | null {
  const parts = name.split('.').filter((p) => p.length > 0);
  if (parts.length < 2) return null;
  const table = parts[parts.length - 1]!;
  const schema = parts[parts.length - 2]!;
  return [schema.toLowerCase(), table.toLowerCase()];
}

export type DatasetResolver = (name: string) => NodeId | null;

export function makeResolver(relations: RelationsMap): DatasetResolver {
  const index = new Map<string, NodeId>();
  for (const node of Object.values(relations.nodes)) {
    index.set(`${node.schema.toLowerCase()}.${node.identifier.toLowerCase()}`, node.uniqueId);
  }
  return (name: string) => {
    const st = schemaTable(name);
    if (!st) return null;
    return index.get(`${st[0]}.${st[1]}`) ?? null;
  };
}

export interface EventEdges {
  columnEdges: Array<{ from: ColumnRef; to: ColumnRef }>;
  datasetEdges: Array<{ from: NodeId; to: NodeId }>;
  unresolved: string[];
}

/** Edges contributed by one event. Events without outputs (tests, run start/end) contribute nothing. */
export function edgesFromEvent(event: RunEvent, resolve: DatasetResolver): EventEdges {
  const out: EventEdges = { columnEdges: [], datasetEdges: [], unresolved: [] };
  const resolveOrNote = (name: string): NodeId | null => {
    const id = resolve(name);
    if (id === null) out.unresolved.push(name);
    return id;
  };
  for (const output of event.outputs) {
    const to = resolveOrNote(output.name);
    if (to === null) continue;
    for (const input of event.inputs) {
      const from = resolveOrNote(input.name);
      if (from !== null && from !== to) out.datasetEdges.push({ from, to });
    }
    const fields = output.facets?.columnLineage?.fields ?? {};
    for (const [column, spec] of Object.entries(fields)) {
      for (const f of spec.inputFields) {
        const from = resolveOrNote(f.name);
        if (from === null) continue;
        out.columnEdges.push({ from: { node: from, column: f.field }, to: { node: to, column } });
        if (from !== to) out.datasetEdges.push({ from, to });
      }
    }
  }
  return out;
}
