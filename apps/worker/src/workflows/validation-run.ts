/**
 * ValidationRunWorkflow (SPEC 13.4): register the run, enqueue a dbt_build job for the runner, wait for the
 * runner's build-complete event, wait until Queues have ingested every check result and lineage event,
 * summarize, dispatch one investigation if anything failed, finalize.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { jsonStep, RETRY_INGEST } from './steps';
import type { AppEnv } from '../env';
import { investigationIds } from '../investigation-ids';
import { auditEvent, createSink } from '../sinks/event-sink';
import {
  countCheckResults,
  countProcessedLineageEvents,
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
        return { status: 'stale' };
      });
      return { runId, status: 'stale' as const };
    }

    if (build.status !== 'completed') {
      await jsonStep(step, 'mark-error', async () => {
        await finishRun(db, runId, 'error');
        return { status: 'error' };
      });
      return { runId, status: 'error' as const, jobId, reason: build.error ?? 'build failed' };
    }

    await jsonStep(
      step,
      'await-ingested',
      async () => {
        const checks = await countCheckResults(db, runId);
        const lineage = await countProcessedLineageEvents(db, runId);
        const wantChecks = build.checkCount ?? 0;
        const wantLineage = build.expectedLineageEvents ?? 0;
        if (checks < wantChecks || lineage < wantLineage) {
          throw new Error(`not yet ingested: checks ${checks}/${wantChecks}, lineage ${lineage}/${wantLineage}`);
        }
        return { checks, lineage };
      },
      RETRY_INGEST,
    );

    const summary = await jsonStep<RunSummary>(step, 'summarize-run', async () => {
      const checks = await listCheckResults(db, runId);
      const out: RunSummary = { pass: 0, fail: 0, error: 0, skip: 0, byCategory: {}, failing: [] };
      for (const c of checks) {
        out[c.status] += 1;
        const cat = (out.byCategory[c.category] ??= { pass: 0, fail: 0, error: 0, skip: 0 });
        cat[c.status] += 1;
        if (c.status === 'fail' || c.status === 'error') out.failing.push(c.checkId);
      }
      return out;
    });

    const failed = summary.fail + summary.error > 0;
    if (failed) {
      await jsonStep(step, 'dispatch-investigation', async () => {
        const ids = await investigationIds(runId, 'checks');
        await this.env.INVESTIGATE_Q.send({ runId, incidentId: ids.incidentId, trigger: 'checks' });
        return ids;
      });
    }

    const status = failed ? ('failed' as const) : ('passed' as const);
    await jsonStep(step, 'finalize', async () => {
      await finishRun(db, runId, status, summary);
      await createSink(this.env).send([
        auditEvent(this.env, 'run_completed', runId, {
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
