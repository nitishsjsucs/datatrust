/**
 * ValidationRunWorkflow (SPEC 13.4): register the run, enqueue a dbt_build job for the runner, wait for the
 * runner's build-complete event, wait until Queues have ingested every check result and lineage event,
 * summarize, dispatch one investigation if anything failed (a failing check, or else a failed metric that the
 * runner's metric watch reported with the build), finalize. A run that cannot finish (no build
 * event within the wait, a failed build, or queues that never caught up) ends 'stale' or 'error' and fails
 * its open jobs, so no runner leases work whose result nothing would receive.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { jsonStep, RETRY_INGEST } from './steps';
import type { AppEnv } from '../env';
import { investigationIds } from '../investigation-ids';
import type { Alert, MetricAlertBody } from '../schemas';
import { auditEvent, auditEventId, createSink } from '../sinks/event-sink';
import {
  countCheckResults,
  countLineageEvents,
  failOpenJobs,
  finishRun,
  insertJob,
  listCheckResults,
  markRunRunning,
} from '../store/repo';

export interface ValidationRunParams {
  runId: string;
  target: 'duckdb' | 'bigquery';
  seed: number | null;
  scenario: string | null;
}

export interface BuildCompletePayload {
  jobId: string;
  status: 'completed' | 'failed';
  checkCount?: number;
  expectedLineageEvents?: number;
  /** Set only when every check passed and a metric moved against the last green run (runner metric watch). */
  metricAlert?: MetricAlertBody;
  error?: string;
}

export interface RunSummary {
  pass: number;
  fail: number;
  error: number;
  skip: number;
  byCategory: Record<string, { pass: number; fail: number; error: number; skip: number }>;
  failing: string[];
}

/** Step await-ingested: two D1 counts; throws (so the step retries) until the queues caught up. */
export async function awaitIngested(db: D1Database, runId: string, build: BuildCompletePayload) {
  const checks = await countCheckResults(db, runId);
  const lineage = await countLineageEvents(db, runId);
  const wantChecks = build.checkCount ?? 0;
  const wantLineage = build.expectedLineageEvents ?? 0;
  if (checks < wantChecks || lineage < wantLineage) {
    throw new Error(`not yet ingested: checks ${checks}/${wantChecks}, lineage ${lineage}/${wantLineage}`);
  }
  return { checks, lineage };
}

/** Step summarize-run: one D1 read. */
export async function summarizeRun(db: D1Database, runId: string): Promise<RunSummary> {
  const checks = await listCheckResults(db, runId);
  const out: RunSummary = { pass: 0, fail: 0, error: 0, skip: 0, byCategory: {}, failing: [] };
  for (const c of checks) {
    out[c.status] += 1;
    const cat = (out.byCategory[c.category] ??= { pass: 0, fail: 0, error: 0, skip: 0 });
    cat[c.status] += 1;
    if (c.status === 'fail' || c.status === 'error') out.failing.push(c.checkId);
  }
  return out;
}

export type Dispatch = { trigger: 'checks'; alert?: undefined } | { trigger: 'alert'; alert: Alert };

/**
 * The one investigation a finished build gets: failing checks start a checks investigation; otherwise a failed
 * metric from the runner's metric watch starts an alert investigation from that metric. Only one, because the
 * checks investigation already traces the run and one investigation per run keeps the Free plan budget per run
 * unchanged (SPEC 28). Null for a green run.
 */
export function dispatchFor(runId: string, summary: RunSummary, build: BuildCompletePayload): Dispatch | null {
  if (summary.fail + summary.error > 0) return { trigger: 'checks' };
  if (build.metricAlert) return { trigger: 'alert', alert: { runId, ...build.metricAlert } };
  return null;
}

export class ValidationRunWorkflow extends WorkflowEntrypoint<AppEnv, ValidationRunParams> {
  override async run(event: WorkflowEvent<ValidationRunParams>, step: WorkflowStep) {
    const { runId, target, seed, scenario } = event.payload;
    const instanceId = event.instanceId;
    const db = this.env.DB;

    await jsonStep(step, 'register-run', async () => {
      await markRunRunning(db, runId, instanceId);
      return { runId };
    });

    const jobId = await jsonStep(step, 'enqueue-build', async () =>
      insertJob(db, {
        jobId: `job_${runId}_build`,
        runId,
        kind: 'dbt_build',
        payload: { runId, target, seed, scenario },
        workflowInstanceId: instanceId,
        eventType: 'build-complete',
      }),
    );

    let build: BuildCompletePayload;
    try {
      const evt = await step.waitForEvent<BuildCompletePayload>('wait-build', { type: 'build-complete', timeout: '6 hours' });
      build = evt.payload;
    } catch {
      await jsonStep(step, 'mark-stale', async () => {
        await finishRun(db, runId, 'stale');
        await failOpenJobs(db, runId, instanceId);
        return { status: 'stale' };
      });
      return { runId, status: 'stale' as const };
    }

    if (build.status !== 'completed') {
      await jsonStep(step, 'mark-error', async () => {
        await finishRun(db, runId, 'error');
        await failOpenJobs(db, runId, instanceId);
        return { status: 'error' };
      });
      return { runId, status: 'error' as const, jobId, reason: build.error ?? 'build failed' };
    }

    try {
      await jsonStep(step, 'await-ingested', async () => awaitIngested(db, runId, build), RETRY_INGEST);
    } catch {
      // Every retry used (about 85 minutes): a check-results or lineage message was dead-lettered. The run
      // ends 'error' instead of staying 'running'; summarizing a partial run would misreport it.
      await jsonStep(step, 'mark-ingest-error', async () => {
        await finishRun(db, runId, 'error');
        await failOpenJobs(db, runId, instanceId);
        return { status: 'error' };
      });
      return { runId, status: 'error' as const, jobId, reason: 'ingest_incomplete' };
    }

    const summary = await jsonStep<RunSummary>(step, 'summarize-run', async () => summarizeRun(db, runId));

    const dispatch = dispatchFor(runId, summary, build);
    const failed = dispatch !== null;
    if (dispatch) {
      await jsonStep(step, 'dispatch-investigation', async () => {
        const ids = await investigationIds(runId, dispatch.trigger, dispatch.alert);
        await this.env.INVESTIGATE_Q.send({ runId, incidentId: ids.incidentId, ...dispatch });
        return ids;
      });
    }

    const status = failed ? ('failed' as const) : ('passed' as const);
    await jsonStep(step, 'finalize', async () => {
      await finishRun(db, runId, status, summary);
      await createSink(this.env).send([
        auditEvent(this.env, 'run_completed', runId, {
          event_id: auditEventId.runCompleted(runId),
          status,
          payload: {
            target,
            seed,
            scenario,
            pass: summary.pass,
            fail: summary.fail,
            error: summary.error,
            skip: summary.skip,
            failing: summary.failing,
          },
        }),
      ]);
      return { status };
    });
    return { runId, status, counts: { pass: summary.pass, fail: summary.fail, error: summary.error, skip: summary.skip } };
  }
}
