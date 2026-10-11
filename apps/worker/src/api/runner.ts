/**
 * Runner protocol (SPEC 13.1, ADR-0001): lease a job, upload artifacts, complete it. Every job call carries
 * X-DataTrust-Lease-Token; a stale or foreign token gets 403. Probe results must already be sanitized by the
 * runner (`rca sanitize`); the Worker re-checks and answers 422 to anything untokenized (ADR-0007).
 */
import { findUnsanitized, type ProbeResult, type RelationsMap } from '@datatrust/rca';
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { type HonoEnv, requireRole } from '../hono';
import { ArtifactSchema, CompleteSchema, LeaseSchema } from '../schemas';
import {
  completeJob,
  getJob,
  isLeaseValid,
  type JobRow,
  leaseJob,
  sweepExhaustedJobs,
  upsertLineageGraph,
} from '../store/repo';
import { sendJobEvent } from './jobs';
import { buildLineageGraph } from '@datatrust/rca';

export const LEASE_HEADER = 'X-DataTrust-Lease-Token';
export const CHECK_RESULTS_PER_MESSAGE = 50;
export const JOB_HEADER = 'X-DataTrust-Job-Id';

export const runner = new Hono<HonoEnv>();

runner.use('*', requireRole('runner'));

runner.post('/lease', async (c) => {
  const body = LeaseSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: 'invalid_body' }, 400);
  for (const job of await sweepExhaustedJobs(c.env.DB)) {
    // The run ends instead of waiting for its timeout; a workflow that is already gone is not an error here.
    await sendJobEvent(c.env, job, { status: 'failed', error: 'lease_attempts_exhausted' }).catch((err) =>
      console.error(`sweep: could not notify ${job.workflow_instance_id}`, err),
    );
  }
  const job = await leaseJob(c.env.DB, body.data.kinds, body.data.runnerId, body.data.target);
  if (!job) return c.body(null, 204);
  return c.json({
    job: {
      jobId: job.job_id,
      runId: job.run_id,
      kind: job.kind,
      payload: JSON.parse(job.payload_json),
      leaseToken: job.lease_token,
      leaseExpiresAt: job.lease_expires_at,
      attempts: job.attempts,
    },
  });
});

async function leasedJob(c: { env: AppEnv; req: { param: (k: string) => string; header: (k: string) => string | undefined } }): Promise<JobRow | null> {
  const job = await getJob(c.env.DB, c.req.param('jobId'));
  return isLeaseValid(job, c.req.header(LEASE_HEADER) ?? null) ? job : null;
}

async function relationsFor(env: AppEnv, runId: string): Promise<RelationsMap | null> {
  const obj = await env.ARTIFACTS.get(`runs/${runId}/relations.json`);
  return obj ? ((await obj.json()) as RelationsMap) : null;
}

runner.post('/jobs/:jobId/artifacts', async (c) => {
  const job = await leasedJob(c);
  if (!job) return c.json({ error: 'forbidden' }, 403);
  const body = ArtifactSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: 'invalid_body' }, 400);
  const { kind, data } = body.data;
  if (kind === 'probe_results') {
    const relations = await relationsFor(c.env, job.run_id);
    if (!relations || !Array.isArray(data)) return c.json({ error: 'invalid_body' }, 400);
    const violations = findUnsanitized(data as ProbeResult[], relations);
    if (violations.length > 0) return c.json({ error: 'unsanitized', violations: violations.slice(0, 20) }, 422);
  }
  const key = kind === 'probe_results' ? `runs/${job.run_id}/probe_results/${job.job_id}.json` : `runs/${job.run_id}/${kind}.json`;
  await c.env.ARTIFACTS.put(key, JSON.stringify(data), { httpMetadata: { contentType: 'application/json' } });
  if (kind === 'relations') {
    // Nodes (with checksums, columns and classifications) are known from relations; edges arrive as events.
    await upsertLineageGraph(c.env.DB, job.run_id, buildLineageGraph([], data as RelationsMap), metaOf(data as RelationsMap));
  }
  return c.json({ stored: key });
});

function metaOf(relations: RelationsMap): Record<string, unknown> {
  return Object.fromEntries(Object.entries(relations.nodes ?? {}).map(([id, n]) => [id, n.meta ?? {}]));
}

runner.post('/jobs/:jobId/complete', async (c) => {
  const job = await leasedJob(c);
  if (!job) return c.json({ error: 'forbidden' }, 403);
  const body = CompleteSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: 'invalid_body' }, 400);
  const b = body.data;
  const token = c.req.header(LEASE_HEADER) ?? '';
  if (job.kind === 'dbt_build') {
    // One message per run (40 or 41 results occur; at most 50 per message, SPEC 13.3, 28.5.2).
    const checks = b.checkResults ?? [];
    const messages = [];
    for (let i = 0; i < checks.length; i += CHECK_RESULTS_PER_MESSAGE) {
      messages.push({ body: { runId: job.run_id, checkResults: checks.slice(i, i + CHECK_RESULTS_PER_MESSAGE) } });
    }
    if (messages.length === 1) await c.env.CHECK_RESULTS_Q.send(messages[0]!.body);
    else if (messages.length > 1) await c.env.CHECK_RESULTS_Q.sendBatch(messages);
    await completeJob(c.env.DB, job.job_id, token, b.status);
    await sendJobEvent(c.env, job, {
      status: b.status,
      checkCount: checks.length,
      expectedLineageEvents: b.expectedLineageEvents ?? 0,
      ...(b.error ? { error: b.error } : {}),
    });
    return c.json({ ok: true, checkMessages: messages.length });
  }
  // diagnostics
  let probeResultsKey: string | undefined;
  if (b.status === 'completed') {
    const relations = await relationsFor(c.env, job.run_id);
    if (!relations) return c.json({ error: 'relations_missing' }, 409);
    const results = (b.probeResults ?? []) as ProbeResult[];
    const violations = findUnsanitized(results, relations);
    if (violations.length > 0) return c.json({ error: 'unsanitized', violations: violations.slice(0, 20) }, 422);
    probeResultsKey = `runs/${job.run_id}/probe_results/${job.job_id}.json`;
    await c.env.ARTIFACTS.put(probeResultsKey, JSON.stringify(results), { httpMetadata: { contentType: 'application/json' } });
  }
  await completeJob(c.env.DB, job.job_id, token, b.status);
  await sendJobEvent(c.env, job, {
    status: b.status,
    ...(probeResultsKey ? { probeResultsKey } : {}),
    ...(b.error ? { error: b.error } : {}),
  });
  return c.json({ ok: true, probeResultsKey: probeResultsKey ?? null });
});
