/**
 * InvestigationWorkflow (SPEC 13.5): load context, trace upstream through column lineage, plan probes, ask
 * the runner to run them (it renders SQL from its own templates and sanitizes before upload), rank with the
 * frozen weights, build sanitized evidence, summarize, persist the incident.
 */
import {
  alertAsCheck,
  buildEvidence,
  type CheckResult,
  findUnsanitized,
  FROZEN_WEIGHTS,
  type LastGreen,
  type LineageGraph,
  planProbes,
  planTimeTravelProbes,
  type ProbeResult,
  type RankedCandidate,
  rankAll,
  type RelationsMap,
  traceUpstream,
} from '@datatrust/rca';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { jsonStep, RETRY_AI, RETRY_LOAD } from './steps';
import type { AppEnv } from '../env';
import { finalizeSummary, shouldRepair, summarizeAttempt } from '../llm/attempt';
import { createSummarizer } from '../llm/summarizer';
import { auditEvent, auditEventId, createSink, lakeDescription } from '../sinks/event-sink';
import { recoveryCommands } from '../recovery';
import type { Alert } from '../schemas';
import {
  baselineChecksums,
  failOpenJobs,
  getRun,
  type IncidentInsert,
  insertJob,
  lastGreenRun,
  listCheckResults,
  loadLineageGraph,
  setRunIncident,
  upsertIncident,
} from '../store/repo';

export interface InvestigationParams {
  runId: string;
  incidentId: string;
  trigger: 'checks' | 'alert';
  alert?: Alert;
}

export interface DiagnosticsCompletePayload {
  jobId: string;
  status: 'completed' | 'failed';
  probeResultsKey?: string;
  error?: string;
}

export interface Context {
  target: string;
  checks: CheckResult[];
  graph: LineageGraph;
  relations: RelationsMap;
  baseline: Record<string, string | null> | null;
  lastGreen: LastGreen | null;
}

/** The shared conversion (`@datatrust/rca`), re-exported for callers of this module. */
export { alertAsCheck };

/**
 * D1 part of step persist-incident: the incident row and the run's incident id (an alert's incident links only
 * a run without one, such as a run whose checks passed but whose metric watch reported a failed metric).
 */
export async function persistIncidentRows(db: D1Database, i: IncidentInsert): Promise<void> {
  await upsertIncident(db, i);
  await setRunIncident(db, i.runId, i.incidentId, i.trigger !== 'checks');
}

export async function readRelations(env: AppEnv, runId: string): Promise<RelationsMap> {
  const obj = await env.ARTIFACTS.get(`runs/${runId}/relations.json`);
  if (!obj) throw new Error(`relations artifact missing for ${runId}`);
  return (await obj.json()) as RelationsMap;
}

/** The summarizer factory, a seam so tests can stand in for the Workers AI binding inside the workflow. */
export const summarizers = { create: createSummarizer };

/** Step load-context: five D1 statements (SPEC 28.5.3, pinned by d1-statements.test.ts) and one R2 read. */
export async function loadContext(env: AppEnv, p: InvestigationParams): Promise<Context> {
  const db = env.DB;
  const run = await getRun(db, p.runId);
  if (!run) throw new Error(`run ${p.runId} not found`);
  const checks = await listCheckResults(db, p.runId);
  if (p.trigger === 'alert' && p.alert) checks.push(alertAsCheck(p.alert));
  return {
    target: run.target,
    checks,
    graph: await loadLineageGraph(db, p.runId),
    relations: await readRelations(env, p.runId),
    baseline: await baselineChecksums(db, p.runId),
    lastGreen: await lastGreenRun(db, p.runId),
  };
}

export class InvestigationWorkflow extends WorkflowEntrypoint<AppEnv, InvestigationParams> {
  override async run(event: WorkflowEvent<InvestigationParams>, step: WorkflowStep) {
    const { runId, incidentId, trigger, alert } = event.payload;
    const env = this.env;
    const db = env.DB;
    const ctx = await jsonStep<Context>(step, 'load-context', async () => loadContext(env, event.payload), RETRY_LOAD);

    const trace = await jsonStep(step, 'trace-lineage', async () => traceUpstream(ctx.checks, ctx.graph, 'column'));

    // Ranking probes, plus evidence-only time-travel probes against the last green run (never ranked).
    const probes = await jsonStep(step, 'plan-probes', async () => [
      ...planProbes(trace.candidates, ctx.graph, ctx.relations),
      ...planTimeTravelProbes(trace.candidates, ctx.relations, ctx.lastGreen ?? null),
    ]);

    const diagJobId = await jsonStep(step, 'request-diagnostics', async () =>
      insertJob(db, {
        jobId: `job_${incidentId}_diag`,
        runId,
        kind: 'diagnostics',
        payload: { runId, incidentId, target: ctx.target, probes },
        workflowInstanceId: event.instanceId,
        eventType: 'diagnostics-complete',
      }),
    );

    let diag: DiagnosticsCompletePayload;
    try {
      const evt = await step.waitForEvent<DiagnosticsCompletePayload>('wait-diagnostics', {
        type: 'diagnostics-complete',
        timeout: '1 hour',
      });
      diag = evt.payload;
    } catch {
      // No diagnostics within the wait: rank without probes, and fail the job so no runner probes for a
      // workflow that has stopped listening (on BigQuery that would spend bytes for nothing).
      await jsonStep(step, 'expire-diagnostics', async () => ({ failed: await failOpenJobs(db, runId, event.instanceId) }));
      diag = { jobId: diagJobId, status: 'failed', error: 'timeout' };
    }

    const ranking = await jsonStep(step, 'rank', async () => {
      let results: ProbeResult[] = [];
      if (diag.status === 'completed' && diag.probeResultsKey) {
        const obj = await env.ARTIFACTS.get(diag.probeResultsKey);
        if (obj) results = (await obj.json()) as ProbeResult[];
      }
      // Defense in depth: the runner sanitized, the API re-checked; check again before use.
      if (findUnsanitized(results, ctx.relations).length > 0) results = [];
      const out = rankAll({
        checks: ctx.checks,
        graph: ctx.graph,
        relations: ctx.relations,
        probeResults: results,
        baselineChecksums: ctx.baseline,
        weights: FROZEN_WEIGHTS,
      });
      return {
        ranked: out.ranked.slice(0, 10) as RankedCandidate[],
        candidateCount: out.ranked.length,
        probeStatus: {
          ok: results.filter((r) => r.status === 'ok').length,
          error: results.filter((r) => r.status === 'error').length,
          missing: results.filter((r) => r.status === 'missing').length,
          diagnostics: diag.status === 'completed' ? 'completed' : (diag.error ?? 'failed'),
        },
        // Which nodes have time-travel evidence against the last green run (SPEC 10); evidence only.
        timeTravel: {
          lastGreenRunId: ctx.lastGreen?.runId ?? null,
          nodes: results
            .filter((r) => r.probe === 'delta_vs_last_green' && r.status === 'ok')
            .map((r) => ({ node: r.node, rowsNow: r.details['n_rows_now'] ?? null, rowsThen: r.details['n_rows_then'] ?? null })),
        },
        probeResultsKey: diag.probeResultsKey ?? null,
      };
    });

    const evidence = await jsonStep(step, 'sanitize', async () => {
      let results: ProbeResult[] = [];
      if (ranking.probeResultsKey) {
        const obj = await env.ARTIFACTS.get(ranking.probeResultsKey);
        if (obj) results = (await obj.json()) as ProbeResult[];
      }
      return buildEvidence({
        incidentId,
        runId,
        trigger,
        checks: ctx.checks,
        ranked: ranking.ranked,
        probeResults: results,
        relations: ctx.relations,
      });
    });

    // One AI call per step (SPEC 28.5.5): a later failure replays these results instead of calling again.
    const summarizer = summarizers.create(env);
    const first = await jsonStep(step, 'summarize-draft', async () => summarizeAttempt(env, summarizer, evidence, 1, null), RETRY_AI);
    const second = shouldRepair(summarizer, first)
      ? await jsonStep(step, 'summarize-repair', async () => summarizeAttempt(env, summarizer, evidence, 2, first), RETRY_AI)
      : null;
    const summary = await jsonStep(step, 'summarize-finalize', async () => finalizeSummary(summarizer, evidence, first, second));

    await jsonStep(step, 'persist-incident', async () => {
      const provenance = {
        environment: env.ENVIRONMENT,
        warehouse: ctx.target === 'bigquery' ? 'bigquery' : 'duckdb (local stand-in for BigQuery)',
        summarizer: {
          provider: summary.provider,
          model: summary.model,
          firstDraftGrounded: summary.firstDraftGrounded,
          repaired: summary.repaired,
          fallback: summary.fallback,
          neurons: summary.neurons,
        },
        lakeSink: lakeDescription(env),
        weights: FROZEN_WEIGHTS,
        probes: ranking.probeStatus,
        timeTravel: ranking.timeTravel,
        candidateCount: ranking.candidateCount,
      };
      // Without dbt's message: viewers read incidents, and a database error can quote a value (the runner
      // already reduces messages to an error class; this is defense in depth).
      const failing = ctx.checks
        .filter((c) => c.status === 'fail' || c.status === 'error')
        .map(({ message: _message, ...check }) => check);
      const evidenceKey = `incidents/${incidentId}.json`;
      const incident = {
        incidentId,
        runId,
        trigger,
        status: 'open',
        failingChecks: failing,
        lineagePath: trace.candidates.map((c) => ({ node: c.node, distance: c.distance, columns: c.columns })),
        ranked: ranking.ranked,
        evidence,
        diagnosticSql: evidence.probes.map((p) => ({ key: p.key, probeId: p.probeId, sql: p.sql })),
        summary: summary.summary,
        summaryDraft: summary.draft,
        recovery: recoveryCommands({ target: ctx.target, runId, ranked: ranking.ranked, relations: ctx.relations }),
        summaryProvider: summary.provider,
        summaryModel: summary.model,
        summaryAttempts: summary.attempts,
        summaryFallback: summary.fallback,
        summaryFallbackReason: summary.fallbackReason,
        provenance,
        createdAt: new Date().toISOString(),
      };
      await env.ARTIFACTS.put(evidenceKey, JSON.stringify(incident), {
        httpMetadata: { contentType: 'application/json' },
      });
      await env.ARTIFACTS.put(`prompts/${incidentId}.json`, JSON.stringify({ prompt: summary.prompt, violations: summary.violations }), {
        httpMetadata: { contentType: 'application/json' },
      });
      await persistIncidentRows(db, {
        incidentId,
        runId,
        trigger,
        status: 'open',
        failingChecks: failing,
        ranked: ranking.ranked,
        evidenceR2Key: evidenceKey,
        summaryDraft: summary.draft,
        summary: summary.summary,
        summaryProvider: summary.provider,
        summaryModel: summary.model,
        summaryAttempts: summary.attempts,
        summaryFallback: summary.fallback,
        summaryFallbackReason: summary.fallbackReason,
        provenance,
      });
      await createSink(env).send([
        auditEvent(env, 'incident_created', runId, {
          event_id: auditEventId.incidentCreated(incidentId),
          status: 'open',
          node: ranking.ranked[0]?.node ?? null,
          payload: {
            incident_id: incidentId,
            trigger,
            top3: ranking.ranked.slice(0, 3).map((c) => c.node),
            failing: failing.map((c) => c.checkId),
            summary_provider: summary.provider,
            summary_fallback: summary.fallback,
          },
        }),
      ]);
      return { incidentId, top: ranking.ranked[0]?.node ?? null };
    });

    return { incidentId, top: ranking.ranked.slice(0, 3).map((c) => c.node) };
  }
}
