/**
 * Workers AI on the Free plan (SPEC 28.5.5, 28.7): a daily neuron ledger in D1 caps spend, each AI call is its
 * own Workflow step, and a refused reservation means no call and a template summary with reason
 * daily_neuron_cap.
 */
import { introspectWorkflowInstance } from 'cloudflare:test';
import { env as baseEnv } from 'cloudflare:workers';
import {
  buildEvidence,
  buildLineageGraph,
  type ChatMessage,
  promptFor,
  rankAll,
  type SanitizedEvidence,
  templateDraft,
} from '@datatrust/rca';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppEnv } from '../src/env';
import { misconfiguration } from '../src/env';
import { investigationIds } from '../src/investigation-ids';
import { DAILY_NEURON_CAP_REASON, finalizeSummary, shouldRepair, summarizeAttempt } from '../src/llm/attempt';
import {
  budgetStatus,
  NEURON_RATES,
  PAID_ONLY_MODELS,
  reservationNeurons,
  reserveNeurons,
  usageNeurons,
  utcDay,
} from '../src/llm/budget';
import { createSummarizer } from '../src/llm/summarizer';
import { SUMMARY_SCHEMA_CHARS, WorkersAISummarizer } from '../src/llm/workers-ai';
import { getIncident, upsertCheckResults, upsertLineageGraph } from '../src/store/repo';
import { summarizers } from '../src/workflows/investigation';
import { request } from './helpers/app';
import { s01 } from './helpers/fixtures';
import { humanClaims, makeKeys, mint, OPERATOR, testEnv, VIEWER } from './helpers/keys';

const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const RATE = NEURON_RATES[MODEL]!;

function evidence(): SanitizedEvidence {
  const out = rankAll({ checks: s01.checks, graph: buildLineageGraph(s01.events, s01.relations), probeResults: s01.probeResults });
  return buildEvidence({
    incidentId: 'inc_b',
    runId: 'run_b',
    trigger: 'checks',
    checks: s01.checks,
    ranked: out.ranked,
    probeResults: s01.probeResults,
    relations: s01.relations,
  });
}

/** A stand-in for the AI binding: scripted answers with optional token usage; counts calls. */
function fakeAi(answers: Array<{ response: unknown; usage?: { prompt_tokens: number; completion_tokens: number } }>) {
  const calls: unknown[] = [];
  const ai = {
    run: async (_model: string, inputs: { messages: ChatMessage[] }) => {
      calls.push(inputs);
      const next = answers.shift();
      if (!next) throw new Error('no scripted answer');
      return next;
    },
  } as unknown as Ai;
  return { ai, calls };
}

let day = 0;
/** A fresh UTC day per test, far from today's, so ledger rows never collide between tests. */
function freshDay(): Date {
  day += 1;
  return new Date(Date.UTC(2001, 0, day, 12));
}

const env = (cap = '2000'): AppEnv => ({ ...(baseEnv as unknown as AppEnv), AI_DAILY_NEURON_CAP: cap });

describe('reservation math', () => {
  it('reserves 187 and 201 neurons for the largest seed-101 first and repair prompts', () => {
    // SPEC 28.3: the largest seed-101 prompt is 3,909 characters and the largest repair prompt 5,430.
    expect(SUMMARY_SCHEMA_CHARS).toBe(971);
    expect(reservationNeurons(3909, SUMMARY_SCHEMA_CHARS, RATE)).toBe(187);
    expect(reservationNeurons(5430, SUMMARY_SCHEMA_CHARS, RATE)).toBe(201);
    // So one incident reserves at most 388, and five need 1,940 of headroom (the smoke's check).
    expect(187 + 201).toBe(388);
    const ev = evidence();
    const chars = (m: ChatMessage[]) => m.reduce((n, x) => n + x.content.length, 0);
    expect(reservationNeurons(chars(promptFor(ev, 1)), SUMMARY_SCHEMA_CHARS, RATE)).toBeLessThanOrEqual(187);
  });

  it('settles from token usage and pins the only model with a rate, which is not a paid-billing model', () => {
    expect(usageNeurons({ prompt_tokens: 1000, completion_tokens: 300 }, RATE)).toBe(89);
    expect(usageNeurons({}, RATE)).toBeNull();
    expect(Object.keys(NEURON_RATES)).toEqual([MODEL]);
    expect(PAID_ONLY_MODELS).not.toContain(MODEL);
  });

  it('keys the ledger by UTC day', async () => {
    expect(utcDay(new Date('2026-10-10T23:59:59.999Z'))).toBe('2026-10-10');
    expect(utcDay(new Date('2026-10-11T00:00:00.000Z'))).toBe('2026-10-11');
    // 07:30 in UTC+10 is still the previous UTC day.
    expect(utcDay(new Date('2026-10-11T07:30:00+10:00'))).toBe('2026-10-10');
    const db = baseEnv.DB;
    expect(await reserveNeurons(db, '2002-01-01', 150, 200)).toBe(true);
    expect(await reserveNeurons(db, '2002-01-01', 60, 200)).toBe(false);
    expect(await reserveNeurons(db, '2002-01-02', 60, 200)).toBe(true);
    expect(await reserveNeurons(db, '2002-01-03', 201, 200)).toBe(false);
    expect(await budgetStatus(db, '2002-01-01', 200)).toEqual({ day: '2002-01-01', cap: 200, reserved: 150, used: 0, calls: 1, headroom: 50 });
    expect((await budgetStatus(db, '2002-01-03', 200)).calls).toBe(0);
  });
});

describe('summary steps under the ledger', () => {
  it('a refused reservation makes no AI call and gives the template with reason daily_neuron_cap', async () => {
    const { ai, calls } = fakeAi([{ response: templateDraft(evidence()) }]);
    const s = new WorkersAISummarizer(ai, MODEL, 'datatrust');
    const ev = evidence();
    const now = freshDay();
    const first = await summarizeAttempt(env('100'), s, ev, 1, null, now);
    expect(first.refused).toBe(true);
    expect(calls).toHaveLength(0);
    expect(shouldRepair(s, first)).toBe(false);
    const out = finalizeSummary(s, ev, first, null);
    expect(out).toMatchObject({ fallback: true, fallbackReason: DAILY_NEURON_CAP_REASON, attempts: 0, provider: 'workers-ai' });
    expect(out.neurons).toEqual({ reserved: 0, used: null });
    expect((await budgetStatus(baseEnv.DB, utcDay(now), 100)).reserved).toBe(0);
  });

  it('replaces the reservation with the usage the response reports, or keeps it when none is reported', async () => {
    const ev = evidence();
    const good = templateDraft(ev);
    const withUsage = fakeAi([{ response: good, usage: { prompt_tokens: 1000, completion_tokens: 300 } }]);
    const now = freshDay();
    const a = await summarizeAttempt(env(), new WorkersAISummarizer(withUsage.ai, MODEL, 'datatrust'), ev, 1, null, now);
    expect(a).toMatchObject({ ok: true, refused: false, usedNeurons: 89 });
    expect(a.reservedNeurons).toBeGreaterThan(89);
    expect(await budgetStatus(baseEnv.DB, utcDay(now), 2000)).toMatchObject({ reserved: 89, used: 89, calls: 1 });

    const noUsage = fakeAi([{ response: good }]);
    const later = freshDay();
    const b = await summarizeAttempt(env(), new WorkersAISummarizer(noUsage.ai, MODEL, 'datatrust'), ev, 1, null, later);
    expect(b.usedNeurons).toBeNull();
    expect(await budgetStatus(baseEnv.DB, utcDay(later), 2000)).toMatchObject({ reserved: b.reservedNeurons, used: b.reservedNeurons });
    expect(finalizeSummary(new WorkersAISummarizer(noUsage.ai, MODEL, 'datatrust'), ev, b, null).neurons).toEqual({
      reserved: b.reservedNeurons,
      used: null,
    });
  });

  it('a repair refused by the cap falls back with daily_neuron_cap after one call', async () => {
    const ev = evidence();
    const bad = { ...templateDraft(ev), impact: 'Exactly 5 rows broke.' };
    const { ai, calls } = fakeAi([{ response: bad }, { response: templateDraft(ev) }]);
    const s = new WorkersAISummarizer(ai, MODEL, 'datatrust');
    const now = freshDay();
    const first = await summarizeAttempt(env('190'), s, ev, 1, null, now);
    expect(first.ok).toBe(false);
    expect(shouldRepair(s, first)).toBe(true);
    const second = await summarizeAttempt(env('190'), s, ev, 2, first, now);
    expect(second.refused).toBe(true);
    expect(calls).toHaveLength(1);
    expect(finalizeSummary(s, ev, first, second)).toMatchObject({ fallback: true, fallbackReason: DAILY_NEURON_CAP_REASON, attempts: 1 });
  });
});

describe('InvestigationWorkflow with Workers AI steps', () => {
  const original = summarizers.create;
  afterEach(() => {
    summarizers.create = original;
  });

  async function seedInvestigation(runId: string) {
    await baseEnv.DB.prepare(`INSERT INTO runs (run_id, target, seed, scenario, status, created_at) VALUES (?, 'duckdb', 101, 'S01', 'failed', ?)`)
      .bind(runId, new Date().toISOString())
      .run();
    await upsertCheckResults(baseEnv.DB, runId, s01.checks);
    await upsertLineageGraph(baseEnv.DB, runId, buildLineageGraph(s01.events, s01.relations));
    await baseEnv.ARTIFACTS.put(`runs/${runId}/relations.json`, JSON.stringify(s01.relations));
    const ids = await investigationIds(runId, 'checks');
    const probeKey = `runs/${runId}/probe_results/job_${ids.incidentId}_diag.json`;
    await baseEnv.ARTIFACTS.put(probeKey, JSON.stringify(s01.probeResults));
    return { ids, probeKey };
  }

  /** Workers AI stand-in inside the workflow: every call answers with a grounded draft and token usage. */
  function groundedWorkersAi() {
    const counter = { calls: 0 };
    const ai = {
      run: async () => {
        counter.calls += 1;
        return { response: null, usage: { prompt_tokens: 1200, completion_tokens: 250 } };
      },
    } as unknown as Ai;
    class GroundedWorkersAI extends WorkersAISummarizer {
      override async draft(messages: ChatMessage[], ev?: SanitizedEvidence): Promise<unknown> {
        await super.draft(messages);
        return templateDraft(ev!);
      }
    }
    summarizers.create = () => new GroundedWorkersAI(ai, MODEL, 'datatrust');
    return counter;
  }

  it('a failure in summarize-finalize replays the stored draft and makes no second AI call', async () => {
    const runId = 'run_budget_wf';
    const { ids, probeKey } = await seedInvestigation(runId);
    const ai = groundedWorkersAi();
    await using instance = await introspectWorkflowInstance(baseEnv.INVESTIGATION, ids.instanceId);
    await instance.modify(async (m) => {
      await m.disableRetryDelays();
      await m.mockEvent({
        type: 'diagnostics-complete',
        payload: { jobId: `job_${ids.incidentId}_diag`, status: 'completed', probeResultsKey: probeKey },
      });
      await m.mockStepError({ name: 'summarize-finalize' }, new Error('transient'), 1);
    });
    await baseEnv.INVESTIGATION.create({ id: ids.instanceId, params: { runId, incidentId: ids.incidentId, trigger: 'checks' } });
    await instance.waitForStatus('complete');
    expect(ai.calls).toBe(1);
    const row = await getIncident(baseEnv.DB, ids.incidentId);
    expect(row?.summary_provider).toBe('workers-ai');
    expect(row?.summary_fallback).toBe(0);
    const provenance = JSON.parse(row!.provenance_json) as { summarizer: { neurons: { used: number } } };
    expect(provenance.summarizer.neurons.used).toBe(usageNeurons({ prompt_tokens: 1200, completion_tokens: 250 }, RATE));
  });

  it('even when summarize-finalize fails on every retry, Workers AI was called once', async () => {
    const runId = 'run_budget_wf2';
    const { ids, probeKey } = await seedInvestigation(runId);
    const ai = groundedWorkersAi();
    await using instance = await introspectWorkflowInstance(baseEnv.INVESTIGATION, ids.instanceId);
    await instance.modify(async (m) => {
      await m.disableRetryDelays();
      await m.mockEvent({
        type: 'diagnostics-complete',
        payload: { jobId: `job_${ids.incidentId}_diag`, status: 'completed', probeResultsKey: probeKey },
      });
      await m.mockStepError({ name: 'summarize-finalize' }, new Error('always'));
    });
    await baseEnv.INVESTIGATION.create({ id: ids.instanceId, params: { runId, incidentId: ids.incidentId, trigger: 'checks' } });
    await instance.waitForStatus('errored');
    expect(ai.calls).toBe(1);
    expect(await getIncident(baseEnv.DB, ids.incidentId)).toBeNull();
  });
});

describe('GET /api/ai/budget and the production guard', () => {
  it('shows today\'s ledger to operators only', async () => {
    const keys = await makeKeys();
    const e = testEnv(keys);
    const res = await request(e, 'GET', '/api/ai/budget', { token: await mint(keys, humanClaims(OPERATOR)) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ day: utcDay(new Date()), cap: 2000, model: MODEL });
    expect(typeof body['headroom']).toBe('number');
    expect((await request(e, 'GET', '/api/ai/budget', { token: await mint(keys, humanClaims(VIEWER)) })).status).toBe(403);
  });

  it('refuses production without a pinned rate for the model or a numeric cap', () => {
    const prod: AppEnv = {
      ...(baseEnv as unknown as AppEnv),
      ENVIRONMENT: 'production',
      ACCESS_MODE: 'cloudflare',
      SUMMARIZER: 'workers-ai',
      AI: {} as Ai,
    };
    expect(misconfiguration(prod)).toBeNull();
    expect(misconfiguration({ ...prod, WORKERS_AI_MODEL: '@cf/zai-org/glm-5.3' })).toMatch(/no pinned neuron rate/);
    expect(misconfiguration({ ...prod, AI_DAILY_NEURON_CAP: 'lots' })).toMatch(/AI_DAILY_NEURON_CAP/);
    expect(() => createSummarizer({ ...prod, SUMMARIZER: 'template' })).toThrow(/workers-ai/);
  });
});
