/**
 * Start-up warm-up (SPEC 28.5.4 applied to code paths). V8 compiles a function the first time it runs, so
 * the first request in a fresh isolate paid for compiling the zod parsers, the router and the lineage
 * code: about 4 ms of a cold request on Apple silicon, likely twice that on the edge's x86 CPUs, against the
 * Free plan's 10 ms per request. Running each parser once on a tiny synthetic input at module scope moves
 * that compile work into Worker start-up (1 s limit). Synchronous, no I/O, and it never throws.
 */
import { buildLineageGraph, edgesFromEvent, findUnsanitized, makeResolver, RunEventSchema, type RelationsMap } from '@datatrust/rca';
import type { Hono } from 'hono';
import { ArtifactSchema, CheckResultsMessage, CompleteSchema, InvestigateMessage, LineageBundleSchema } from './schemas';
import { schemaProblems } from './sinks/event-sink';

export const warmUpRelations: RelationsMap = {
  nodes: {
    'source.w.raw.a': { uniqueId: 'source.w.raw.a', kind: 'source', schema: 'raw', identifier: 'a', name: 'a', relation: 'raw.a', columns: { x: { name: 'x', classification: 'identifier' } } },
    'model.w.b': { uniqueId: 'model.w.b', kind: 'model', schema: 'staging', identifier: 'b', name: 'b', relation: 'staging.b', columns: { x: { name: 'x', classification: 'identifier' } } },
  },
} as unknown as RelationsMap;

export const warmUpEvent = {
  eventType: 'COMPLETE',
  eventTime: '2026-01-01T00:00:00.000Z',
  run: { runId: '00000000-0000-4000-8000-000000000000' },
  job: { namespace: 'dbt', name: 'w.b' },
  inputs: [{ namespace: 'duckdb://w', name: 'w.raw.a' }],
  outputs: [
    {
      namespace: 'duckdb://w',
      name: 'w.staging.b',
      facets: { columnLineage: { fields: { x: { inputFields: [{ namespace: 'duckdb://w', name: 'w.raw.a', field: 'x' }] } } } },
    },
  ],
};

export const warmUpCheck = {
  checkId: 'W01',
  testName: 'dq_w01',
  category: 'uniqueness',
  kind: 'data_test',
  status: 'pass',
  failures: 0,
  node: 'model.w.b',
  columns: ['x'],
  message: null,
};

export const warmUpProbe = {
  probeId: 'dup_key_rate:model.w.b:x',
  probe: 'dup_key_rate',
  node: 'model.w.b',
  columns: ['x'],
  metric: 'dup_key_rate',
  value: 0,
  anomaly: 0,
  sql: ['select 1'],
  dialect: 'duckdb',
  status: 'ok',
  sampleKeys: [{ x: 'emp_0123456789' }],
  details: { n: 1 },
};

export function warmUp(router?: Pick<Hono['router'], 'match'>): void {
  try {
    const parsed = RunEventSchema.parse(warmUpEvent);
    edgesFromEvent(parsed, makeResolver(warmUpRelations));
    buildLineageGraph([warmUpEvent], warmUpRelations);
    CompleteSchema.safeParse({
      status: 'completed',
      checkResults: [warmUpCheck],
      probeResults: [warmUpProbe],
      expectedLineageEvents: 1,
    });
    CheckResultsMessage.safeParse({ runId: 'w', checkResults: [warmUpCheck] });
    LineageBundleSchema.safeParse({ runId: 'w', events: [{ eventId: 'e', r2Key: 'k' }] });
    InvestigateMessage.safeParse({ runId: 'w', incidentId: 'i', trigger: 'checks' });
    ArtifactSchema.safeParse({ kind: 'relations', data: {} });
    findUnsanitized([warmUpProbe] as never, warmUpRelations);
    schemaProblems({ event_id: 'e' });
    router?.match('GET', '/healthz');
    router?.match('POST', '/api/v1/lineage');
  } catch {
    // A warm-up problem must never stop the Worker from starting.
  }
}
