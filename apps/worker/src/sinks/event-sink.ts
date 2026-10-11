/**
 * Audit events to the lake (SPEC 13.9).
 * Production: PipelinesSink sends to the Basin Pipelines stream `datatrust_events` (binding EVENTS), whose
 * pipeline writes the Basin Catalog Iceberg table datatrust.audit_events on R2 bucket datatrust-lake.
 * Local stand-in: R2NdjsonSink writes NDJSON objects under lake/ in the local R2 bucket; `datatrust lake sync`
 * appends them to a pyiceberg SQL catalog. Pipelines silently drops schema-invalid records after accepting
 * them, so every event is checked against schemas/lake/audit_event.stream.json before it is sent.
 */
import streamSchema from '../../../../schemas/lake/audit_event.stream.json';
import type { AppEnv, PipelineStream } from '../env';
import { ulid } from '../ids';

type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export interface AuditEvent {
  event_id: string;
  event_type: 'check_result' | 'run_completed' | 'incident_created';
  environment: 'local' | 'production';
  run_id: string;
  /** RFC 3339 UTC, e.g. 2026-10-10T17:00:00.000Z. */
  occurred_at: string;
  check_id: string | null;
  status: string | null;
  node: string | null;
  payload: { [k: string]: JsonValue };
}

export interface EventSink {
  readonly kind: 'basin-pipelines' | 'r2-ndjson';
  send(events: AuditEvent[]): Promise<void>;
}

interface StreamField {
  name: string;
  type: 'string' | 'timestamp' | 'json';
  required: boolean;
}

export const STREAM_FIELDS = (streamSchema as { fields: StreamField[] }).fields;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Problems that would make Pipelines drop the record; empty when the event matches the stream schema. */
export function schemaProblems(event: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const names = new Set(STREAM_FIELDS.map((f) => f.name));
  for (const key of Object.keys(event)) if (!names.has(key)) problems.push(`unknown field ${key}`);
  for (const f of STREAM_FIELDS) {
    const v = event[f.name];
    if (v === null || v === undefined) {
      if (f.required) problems.push(`${f.name} is required`);
      continue;
    }
    if (f.type === 'string' && typeof v !== 'string') problems.push(`${f.name} must be a string`);
    if (f.type === 'timestamp' && !(typeof v === 'string' && RFC3339.test(v) && !Number.isNaN(Date.parse(v)))) {
      problems.push(`${f.name} must be an RFC 3339 timestamp`);
    }
    if (f.type === 'json' && (typeof v !== 'object' || Array.isArray(v))) problems.push(`${f.name} must be a JSON object`);
  }
  return problems;
}

function assertValid(events: AuditEvent[]): void {
  for (const e of events) {
    const p = schemaProblems(e as unknown as Record<string, unknown>);
    if (p.length) throw new Error(`audit event ${e.event_id} does not match the stream schema: ${p.join('; ')}`);
  }
}

export class PipelinesSink implements EventSink {
  readonly kind = 'basin-pipelines' as const;
  constructor(private readonly stream: PipelineStream) {}

  async send(events: AuditEvent[]): Promise<void> {
    if (!events.length) return;
    assertValid(events);
    await this.stream.send(events);
  }
}

export class R2NdjsonSink implements EventSink {
  readonly kind = 'r2-ndjson' as const;
  constructor(private readonly bucket: R2Bucket) {}

  async send(events: AuditEvent[]): Promise<void> {
    if (!events.length) return;
    assertValid(events);
    const now = new Date();
    // Keys sort by time: lake/<date>/<ulid>.ndjson
    const key = `lake/${now.toISOString().slice(0, 10)}/${ulid(now.getTime())}.ndjson`;
    await this.bucket.put(key, events.map((e) => JSON.stringify(e)).join('\n') + '\n', {
      httpMetadata: { contentType: 'application/x-ndjson' },
    });
  }
}

export function createSink(env: AppEnv): EventSink {
  return env.EVENTS ? new PipelinesSink(env.EVENTS) : new R2NdjsonSink(env.ARTIFACTS);
}

export function auditEvent(
  env: AppEnv,
  type: AuditEvent['event_type'],
  runId: string,
  fields: Partial<Pick<AuditEvent, 'check_id' | 'status' | 'node'>> & { payload?: AuditEvent['payload'] } = {},
): AuditEvent {
  return {
    event_id: `evt_${ulid()}`,
    event_type: type,
    environment: env.ENVIRONMENT,
    run_id: runId,
    occurred_at: new Date().toISOString(),
    check_id: fields.check_id ?? null,
    status: fields.status ?? null,
    node: fields.node ?? null,
    payload: fields.payload ?? {},
  };
}
