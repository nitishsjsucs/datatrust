/**
 * `rca <command>`: JSON on stdin, JSON on stdout. Bundled to dist/cli.mjs and called by the Python runner
 * and the offline benchmark, so they use exactly the code the Worker runs (ADR-0002).
 *
 *   graph            {events, relations}                                  -> LineageGraph
 *   trace            {checks, graph|events, relations, mode?}             -> {candidates, failing}
 *   plan             {checks, graph|events, relations}                    -> {candidates, failing, probes}
 *   rank             {checks, graph|events, relations, probeResults, baselineChecksums?, weights?}
 *                                                                         -> {ranked, features, ablations, baselines}
 *   sanitize         {probeResults, relations}  (EVIDENCE_HMAC_KEY env)   -> {probeResults}
 *   check-sanitized  {probeResults, relations}                            -> {violations}
 *   tune             {trials}                                             -> {weights, top1, top3, mrr, n}
 *   evaluate         {trials, weights}                                    -> {top1, top3, mrr, n}
 *   loso             {dev, test}                                          -> {pooled, perScenario}
 *   coverage         {graph|events, relations}                            -> {covered, total, share}
 *   evidence         {incidentId, runId, trigger, checks, ranked, probeResults, relations} -> SanitizedEvidence
 *   prompt           {evidence}                                           -> {messages}
 *   validate         {draft, evidence}                                    -> {ok, violations}
 *   template         {evidence}                                           -> {draft, rendered}
 *   summarize        {evidence, provider: template|local-llm, llmUrl?}    -> SummaryOutcome (+ rawDrafts)
 *   schema           {}                                                   -> IncidentSummary JSON Schema
 *
 * Inputs are closed: an unexpected top-level key is an error, so ground truth (a scenario id) can never reach
 * the ranker by accident (SPEC 11).
 */
import { readFileSync } from 'node:fs';
import { buildEvidence, type SanitizedEvidence } from './evidence/evidence';
import { findUnsanitized, sanitizeProbeResults } from './evidence/sanitize';
import {
  OpenAICompatSummarizer,
  type Summarizer,
  summarizeGrounded,
  TemplateSummarizer,
} from './summary/grounded';
import { buildPrompt, type ChatMessage } from './summary/prompt';
import { renderSummary } from './summary/render';
import { incidentSummaryJsonSchema } from './summary/schema';
import { templateDraft } from './summary/template';
import { validateSummary } from './summary/validate';
import { buildLineageGraph, columnLineageCoverage } from './lineage/graph';
import { baselineOrders } from './rca/baselines';
import { planProbes } from './rca/plan';
import { rankAll } from './rca/rank';
import { traceUpstream } from './rca/trace';
import { evaluate, leaveOneScenarioOut, tune } from './rca/tune';
import { FROZEN_WEIGHTS } from './rca/weights';
import type { CheckResult, LineageGraph, ProbeResult, RankedCandidate, RelationsMap } from './types';

type Input = Record<string, unknown>;

const COMMON = ['checks', 'graph', 'events', 'relations'];
const ALLOWED_KEYS: Record<string, string[]> = {
  graph: ['events', 'relations'],
  trace: [...COMMON, 'mode'],
  plan: COMMON,
  rank: [...COMMON, 'probeResults', 'baselineChecksums', 'weights'],
  sanitize: ['probeResults', 'relations'],
  'check-sanitized': ['probeResults', 'relations'],
  tune: ['trials'],
  evaluate: ['trials', 'weights'],
  loso: ['dev', 'test'],
  coverage: ['graph', 'events', 'relations'],
  weights: [],
  schema: [],
  evidence: ['incidentId', 'runId', 'trigger', 'checks', 'ranked', 'probeResults', 'relations'],
  prompt: ['evidence'],
  validate: ['draft', 'evidence'],
  template: ['evidence'],
  summarize: ['evidence', 'provider', 'llmUrl'],
};

export function assertClosedInput(command: string, input: Input): void {
  const allowed = ALLOWED_KEYS[command];
  if (!allowed) throw new Error(`unknown command ${command}`);
  const extra = Object.keys(input).filter((k) => !allowed.includes(k));
  if (extra.length) throw new Error(`unexpected input for ${command}: ${extra.join(', ')}`);
}

function graphOf(input: Input): LineageGraph {
  if (input['graph']) return input['graph'] as LineageGraph;
  return buildLineageGraph((input['events'] as unknown[]) ?? [], input['relations'] as RelationsMap);
}

async function run(command: string, input: Input): Promise<unknown> {
  assertClosedInput(command, input);
  switch (command) {
    case 'graph':
      return graphOf(input);
    case 'trace': {
      const mode = input['mode'] === 'dataset' ? 'dataset' : 'column';
      return traceUpstream(input['checks'] as CheckResult[], graphOf(input), mode);
    }
    case 'plan': {
      const g = graphOf(input);
      const trace = traceUpstream(input['checks'] as CheckResult[], g, 'column');
      return { ...trace, probes: planProbes(trace.candidates, g, input['relations'] as RelationsMap) };
    }
    case 'rank': {
      const out = rankAll({
        checks: input['checks'] as CheckResult[],
        graph: graphOf(input),
        relations: input['relations'] as RelationsMap,
        probeResults: (input['probeResults'] as ProbeResult[]) ?? [],
        baselineChecksums: (input['baselineChecksums'] as Record<string, string | null>) ?? null,
        weights: (input['weights'] as typeof FROZEN_WEIGHTS) ?? FROZEN_WEIGHTS,
      });
      return { ...out, baselines: baselineOrders(out.features.column) };
    }
    case 'sanitize': {
      const key = process.env['EVIDENCE_HMAC_KEY'] ?? '';
      const results = await sanitizeProbeResults(
        input['probeResults'] as ProbeResult[],
        input['relations'] as RelationsMap,
        { key },
      );
      return { probeResults: results };
    }
    case 'check-sanitized':
      return { violations: findUnsanitized(input['probeResults'] as ProbeResult[], input['relations'] as RelationsMap) };
    case 'tune':
      return tune(input['trials'] as Parameters<typeof tune>[0]);
    case 'evaluate':
      return evaluate(input['trials'] as Parameters<typeof evaluate>[0], input['weights'] as typeof FROZEN_WEIGHTS);
    case 'loso':
      return leaveOneScenarioOut(
        input['dev'] as Parameters<typeof leaveOneScenarioOut>[0],
        input['test'] as Parameters<typeof leaveOneScenarioOut>[1],
      );
    case 'coverage':
      return columnLineageCoverage(graphOf(input));
    case 'weights':
      return FROZEN_WEIGHTS;
    case 'schema':
      return incidentSummaryJsonSchema;
    case 'evidence':
      return buildEvidence({
        incidentId: String(input['incidentId'] ?? 'incident'),
        runId: String(input['runId'] ?? 'run'),
        trigger: input['trigger'] === 'alert' ? 'alert' : 'checks',
        checks: input['checks'] as CheckResult[],
        ranked: input['ranked'] as RankedCandidate[],
        probeResults: input['probeResults'] as ProbeResult[],
        relations: input['relations'] as RelationsMap,
      });
    case 'prompt':
      return { messages: buildPrompt(input['evidence'] as SanitizedEvidence) };
    case 'validate':
      return validateSummary(input['draft'], input['evidence'] as SanitizedEvidence);
    case 'summarize': {
      const ev = input['evidence'] as SanitizedEvidence;
      const base: Summarizer =
        input['provider'] === 'local-llm'
          ? new OpenAICompatSummarizer(String(input['llmUrl'] ?? 'http://127.0.0.1:8160'))
          : new TemplateSummarizer();
      // Record every raw provider answer, so the eval can report JSON validity and scan drafts for PII.
      const rawDrafts: string[] = [];
      const recording: Summarizer = {
        provider: base.provider,
        model: base.model,
        draft: async (messages: ChatMessage[], evidence: SanitizedEvidence) => {
          const raw = await base.draft(messages, evidence);
          rawDrafts.push(typeof raw === 'string' ? raw : JSON.stringify(raw));
          return raw;
        },
      };
      const outcome = await summarizeGrounded(recording, ev);
      return { ...outcome, rawDrafts };
    }
    case 'template': {
      const ev = input['evidence'] as SanitizedEvidence;
      const draft = templateDraft(ev);
      return { draft, rendered: renderSummary(draft, ev) };
    }
    default:
      throw new Error(`unknown command ${command}`);
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? '';
  const raw = command === 'weights' || command === 'schema' ? '{}' : readFileSync(0, 'utf8');
  const input = JSON.parse(raw || '{}') as Input;
  const out = await run(command, input);
  process.stdout.write(JSON.stringify(out));
}

main().catch((err: unknown) => {
  process.stderr.write(`rca: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
