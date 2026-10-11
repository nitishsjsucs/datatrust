/** zod mirrors of schemas/api/*.json: request bodies and queue messages (SPEC 13.1, 13.3). */
import { z } from 'zod';

export const CheckResultSchema = z.object({
  checkId: z.string().min(1).max(200),
  testName: z.string().min(1).max(200),
  category: z.string().min(1).max(64),
  kind: z.enum(['data_test', 'schema_contract', 'model_error']),
  status: z.enum(['pass', 'fail', 'error', 'skip']),
  failures: z.number().int().min(0),
  node: z.string().min(1).max(300),
  columns: z.array(z.string().max(200)).max(200),
  message: z.string().max(4000).nullable().optional(),
  also: z.array(z.object({ node: z.string(), columns: z.array(z.string()) })).max(20).optional(),
});

const JsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(JsonValue), z.record(z.string(), JsonValue)]),
);

export const ProbeResultSchema = z.object({
  probeId: z.string().min(1).max(500),
  probe: z.string().min(1).max(64),
  node: z.string().min(1).max(300),
  columns: z.array(z.string()),
  metric: z.string(),
  value: z.number(),
  anomaly: z.number().min(0).max(1),
  sql: z.array(z.string().max(20_000)).max(4),
  dialect: z.string(),
  status: z.enum(['ok', 'error', 'missing']),
  sampleKeys: z.array(z.record(z.string(), JsonValue)).max(5),
  details: z.record(z.string(), JsonValue),
  error: z.string().max(200).nullable().optional(),
});

export const CreateRunSchema = z.object({
  target: z.enum(['duckdb', 'bigquery']),
  seed: z.number().int().min(0).max(1_000_000).optional(),
  scenario: z.string().regex(/^[ST]\d{2}$/).optional(),
});

export const LeaseSchema = z.object({
  runnerId: z.string().min(1).max(100),
  kinds: z.array(z.enum(['dbt_build', 'diagnostics'])).min(1),
  target: z.enum(['duckdb', 'bigquery']),
});

export const ArtifactSchema = z.object({
  kind: z.enum(['run_results', 'relations', 'probe_results']),
  data: z.unknown(),
});

export const CompleteSchema = z.object({
  status: z.enum(['completed', 'failed']),
  checkResults: z.array(CheckResultSchema).max(500).optional(),
  probeResults: z.array(ProbeResultSchema).max(1000).optional(),
  expectedLineageEvents: z.number().int().min(0).optional(),
  error: z.string().max(200).optional(),
});

export const AlertSchema = z.object({
  runId: z.string().min(1).max(100),
  metricNode: z.string().regex(/^model\.[a-z_]+\.[a-z0-9_]+$/),
  column: z.string().regex(/^[a-z_][a-z0-9_]*$/).optional(),
  observed: z.number(),
  expected: z.number(),
});

export const CheckResultsMessage = z.object({ runId: z.string(), checkResults: z.array(CheckResultSchema) });
export const LineageMessage = z.object({ runId: z.string(), eventId: z.string(), r2Key: z.string() });
export const InvestigateMessage = z.object({
  runId: z.string(),
  incidentId: z.string(),
  trigger: z.enum(['checks', 'alert']),
  alert: AlertSchema.optional(),
});

export type CreateRun = z.infer<typeof CreateRunSchema>;
export type Alert = z.infer<typeof AlertSchema>;
export type InvestigateMsg = z.infer<typeof InvestigateMessage>;
