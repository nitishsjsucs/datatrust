import { env as baseEnv } from 'cloudflare:workers';
import { insertJob, insertRun } from '../../src/store/repo';

/** A run with a dbt_build job already leased to the runner; returns the headers lineage POSTs need. */
export async function leasedBuildJob(runId: string): Promise<Record<string, string>> {
  await insertRun(baseEnv.DB, { runId, target: 'duckdb', seed: 101, scenario: null });
  const jobId = `job_${runId}_build`;
  await insertJob(baseEnv.DB, {
    jobId,
    runId,
    kind: 'dbt_build',
    payload: { runId, target: 'duckdb', seed: 101, scenario: null },
    workflowInstanceId: runId,
    eventType: 'build-complete',
  });
  const token = `lease_${runId}`;
  await baseEnv.DB.prepare(
    `UPDATE jobs SET status = 'leased', lease_token = ?, lease_owner = 'test', lease_expires_at = ?, attempts = 1 WHERE job_id = ?`,
  )
    .bind(token, Date.now() + 15 * 60 * 1000, jobId)
    .run();
  return { 'X-DataTrust-Job-Id': jobId, 'X-DataTrust-Lease-Token': token };
}

/** A producer stand-in that records every message body. */
export function recordingQueue<T = unknown>() {
  const bodies: T[] = [];
  const queue = {
    send: async (body: T) => void bodies.push(body),
    sendBatch: async (batch: Iterable<MessageSendRequest<T>>) => {
      for (const m of batch) bodies.push(m.body);
    },
  } as unknown as Queue;
  return { queue, bodies };
}

/** n distinct copies of the fixture events (eventTime differs), for message-count tests. */
export function manyEvents(events: unknown[], n: number): unknown[] {
  return Array.from({ length: n }, (_, i) => {
    const ev = events[i % events.length] as Record<string, unknown>;
    return { ...ev, eventTime: new Date(Date.UTC(2026, 9, 10, 0, 0, i)).toISOString() };
  });
}
