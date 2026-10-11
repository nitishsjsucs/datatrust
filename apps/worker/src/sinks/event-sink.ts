/**
 * Audit events to the lake (SPEC 13.9, 28.5.1, ADR-0008). Same path locally and in production:
 * QueueSink validates each event against schemas/lake/audit_event.stream.json and sends messages of at most
 * 50 events (and under 64 KB, so one message is one queue operation) to `datatrust-audit-events`. The consumer
 * (queues/audit-events.ts) writes each batch as one immutable `lake/<date>/<ulid>.ndjson` object in R2, and
 * `datatrust lake commit` adds the settled objects to the Iceberg table once per event_id (Basin Catalog in
 * production, a pyiceberg SQL catalog locally). Basin Pipelines is Workers Paid only and is not used.
 */
import streamSchema from '../../../../schemas/lake/audit_event.stream.json';
import type { AppEnv } from '../env';

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

export interface AuditMessage {
  events: AuditEvent[];
}

export interface EventSink {
  readonly kind: 'queue';
  send(events: AuditEvent[]): Promise<void>;
}

/** At most this many events per queue message (SPEC 13.3). */
export const AUDIT_MESSAGE_MAX_EVENTS = 50;
/** Queues bill one operation per 64 KB of a message; staying below keeps each message at one operation. */
export const AUDIT_MESSAGE_MAX_BYTES = 60_000;

/**
 * Deterministic event ids: a redelivered queue message or a retried workflow step repeats the same id, and
 * the committer keeps the first row per id (SPEC 28.5.1).
 */
export const auditEventId = {
  checkResult: (runId: string, checkId: string) => `evt_${runId}_check_${checkId}`,
  runCompleted: (runId: string) => `evt_${runId}_run_completed`,
  incidentCreated: (incidentId: string) => `evt_${incidentId}_created`,
};

interface StreamField {
  name: string;
  type: 'string' | 'timestamp' | 'json';
  required: boolean;
}

export const STREAM_FIELDS = (streamSchema as { fields: StreamField[] }).fields;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Problems that would make the event unusable in the lake; empty when it matches the lake schema. */
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

export function assertValid(events: AuditEvent[]): void {
  for (const e of events) {
    const p = schemaProblems(e as unknown as Record<string, unknown>);
    if (p.length) throw new Error(`audit event ${e.event_id} does not match the lake schema: ${p.join('; ')}`);
  }
}

/** Split events into messages of at most 50 events and AUDIT_MESSAGE_MAX_BYTES of JSON. */
export function auditMessages(events: AuditEvent[]): AuditMessage[] {
  const out: AuditMessage[] = [];
  let current: AuditEvent[] = [];
  let bytes = 0;
  for (const e of events) {
    const size = JSON.stringify(e).length + 1;
    if (current.length && (current.length >= AUDIT_MESSAGE_MAX_EVENTS || bytes + size > AUDIT_MESSAGE_MAX_BYTES)) {
      out.push({ events: current });
      current = [];
      bytes = 0;
    }
    current.push(e);
    bytes += size;
  }
  if (current.length) out.push({ events: current });
  return out;
}

export class QueueSink implements EventSink {
  readonly kind = 'queue' as const;
  constructor(private readonly queue: Queue<AuditMessage>) {}

  async send(events: AuditEvent[]): Promise<void> {
    if (!events.length) return;
    assertValid(events);
    const messages = auditMessages(events);
    if (messages.length === 1) await this.queue.send(messages[0]!);
    else await this.queue.sendBatch(messages.map((body) => ({ body })));
  }
}

export function createSink(env: AppEnv): EventSink {
  return new QueueSink(env.AUDIT_Q as Queue<AuditMessage>);
}

/** Human-readable description of the lake path, recorded in incident provenance. */
export function lakeDescription(env: AppEnv): string {
  return env.ENVIRONMENT === 'production'
    ? 'queue datatrust-audit-events, R2 lake/ objects, Basin Catalog via datatrust lake commit'
    : 'queue datatrust-audit-events, R2 lake/ objects, pyiceberg SQL catalog (local stand-in for Basin Catalog)';
}

export function auditEvent(
  env: AppEnv,
  type: AuditEvent['event_type'],
  runId: string,
  fields: Partial<Pick<AuditEvent, 'check_id' | 'status' | 'node'>> & {
    event_id: string;
    payload?: AuditEvent['payload'];
  },
): AuditEvent {
  return {
    event_id: fields.event_id,
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
