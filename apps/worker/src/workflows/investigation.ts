/**
 * InvestigationWorkflow (SPEC 13.5): load context, trace upstream through column lineage, plan probes, ask
 * the runner to run them (it renders SQL from its own templates and sanitizes before upload), rank with the
 * frozen weights, build sanitized evidence, summarize, persist the incident.
 */
import {
  buildEvidence,
  type CheckResult,
  findUnsanitized,
  FROZEN_WEIGHTS,
  type LineageGraph,
  planProbes,
  type ProbeResult,
  type RankedCandidate,
  rankAll,
  type RelationsMap,
  traceUpstream,
} from '@datatrust/rca';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { jsonStep, RETRY_LOAD } from './steps';
import type { AppEnv } from '../env';
import { createSummarizer, summarizeGrounded } from '../llm/summarizer';
import { auditEvent, createSink } from '../sinks/event-sink';
import { recoveryCommands } from '../recovery';
import type { Alert } from '../schemas';
import {
  baselineChecksums,
  getRun,
  insertJob,
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

interface Context {
  target: string;
  checks: CheckResult[];
  graph: LineageGraph;
  relations: RelationsMap;
  baseline: Record<string, string | null> | null;
}

export function alertAsCheck(alert: Alert): CheckResult {
  return {
    checkId: `alert:${alert.metricNode.split('.').pop()}`,
    testName: 'metric_alert',
    category: 'alert',
    kind: 'data_test',
    status: 'fail',
    failures: 1,
    node: alert.metricNode,
    columns: alert.column ? [alert.column] : [],
  };
}

export async function readRelations(env: AppEnv, runId: string): Promise<RelationsMap> {
  const obj = await env.ARTIFACTS.get(`runs/${runId}/relations.json`);
  if (!obj) throw new Error(`relations artifact missing for ${runId}`);
  return (await obj.json()) as RelationsMap;
}

export class InvestigationWorkflow extends WorkflowEntrypoint<AppEnv, InvestigationParams> {
  override async run(event: WorkflowEvent<InvestigationParams>, step: WorkflowStep) {
    const { runId, incidentId, trigger, alert } = event.payload;
    const env = this.env;
    const db = env.DB;
    const ctx = await jsonStep<Context>(step, 'load-context', async () => {
      const run = await getRun(db, runId);
      if (!run) throw new Error(`run ${runId} not found`);
      const checks = await listCheckResults(db, runId);
      if (trigger === 'alert' && alert) checks.push(alertAsCheck(alert));
      return {
        target: run.target,
        checks,
        graph: await loadLineageGraph(db, runId),
        relations: await readRelations(env, runId),
        baseline: await baselineChecksums(db, runId),
      };
    }, RETRY_LOAD);

    const trace = await jsonStep(step, 'trace-lineage', async () => traceUpstream(ctx.checks, ctx.graph, 'column'));

    const probes = await jsonStep(step, 'plan-probes', async () => planProbes(trace.candidates, ctx.graph, ctx.relations));

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

    const summary = await jsonStep(step, 'summarize', async () => summarizeGrounded(createSummarizer(env), evidence));

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
        },
        lakeSink: createSink(env).kind === 'basin-pipelines' ? 'basin-pipelines' : 'r2-ndjson (local stand-in for Basin Pipelines)',
        weights: FROZEN_WEIGHTS,
        probes: ranking.probeStatus,
        candidateCount: ranking.candidateCount,
      };
      const failing = ctx.checks.filter((c) => c.status === 'fail' || c.status === 'error');
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
      await upsertIncident(db, {
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
      if (trigger === 'checks') await setRunIncident(db, runId, incidentId);
      await createSink(env).send([
        auditEvent(env, 'incident_created', runId, {
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
