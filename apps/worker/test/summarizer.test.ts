import { env as baseEnv } from 'cloudflare:workers';
import { buildEvidence, type ChatMessage, type SanitizedEvidence, templateDraft } from '@datatrust/rca';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../src/env';
import { OpenAICompatSummarizer } from '../src/llm/openai-compatible';
import { createSummarizer, type Summarizer, summarizeGrounded } from '../src/llm/summarizer';
import { TemplateSummarizer } from '../src/llm/template';
import { WorkersAISummarizer } from '../src/llm/workers-ai';
import { recoveryCommands } from '../src/recovery';
import { s01 } from './helpers/fixtures';
import { rankAll } from '@datatrust/rca';
import { buildLineageGraph } from '@datatrust/rca';

function evidence(): SanitizedEvidence {
  const out = rankAll({
    checks: s01.checks,
    graph: buildLineageGraph(s01.events, s01.relations),
    probeResults: s01.probeResults,
  });
  return buildEvidence({
    incidentId: 'inc_t',
    runId: 'run_t',
    trigger: 'checks',
    checks: s01.checks,
    ranked: out.ranked,
    probeResults: s01.probeResults,
    relations: s01.relations,
  });
}

class Scripted implements Summarizer {
  readonly provider = 'workers-ai' as const;
  readonly model = 'scripted';
  calls: ChatMessage[][] = [];
  constructor(private readonly drafts: Array<unknown | Error>) {}
  async draft(messages: ChatMessage[]) {
    this.calls.push(messages);
    const next = this.drafts.shift();
    if (next instanceof Error) throw next;
    return next;
  }
}

describe('grounded summarization', () => {
  const ev = evidence();
  const good = templateDraft(ev);

  it('accepts a grounded first draft and renders placeholders server-side', async () => {
    const out = await summarizeGrounded(new Scripted([JSON.stringify(good)]), ev);
    expect(out).toMatchObject({ attempts: 1, firstDraftGrounded: true, repaired: false, fallback: false });
    expect(out.summary.impact).not.toContain('{ev:');
    expect(out.summary.impact).toMatch(/\d+ failing rows/);
  });

  it('asks once for a repair quoting the exact violations', async () => {
    const bad = { ...good, impact: 'Exactly 5 rows broke.' };
    const s = new Scripted([bad, good]);
    const out = await summarizeGrounded(s, ev);
    expect(out).toMatchObject({ attempts: 2, firstDraftGrounded: false, repaired: true, fallback: false });
    expect(s.calls[1]!.at(-1)!.content).toContain('impact: contains the number "5" outside a placeholder');
  });

  it('falls back to the template after a failed repair and records why', async () => {
    const bad = { ...good, title: 'Broken 42 times' };
    const out = await summarizeGrounded(new Scripted([bad, bad]), ev);
    expect(out.fallback).toBe(true);
    expect(out.attempts).toBe(2);
    expect(out.fallbackReason).toContain('title: contains the number "42"');
    expect(out.draft).toEqual(good);
  });

  it('falls back immediately when the provider throws (JSON mode could not be met)', async () => {
    const out = await summarizeGrounded(new Scripted([new Error("JSON Mode couldn't be met")]), ev);
    expect(out).toMatchObject({ fallback: true, attempts: 1, fallbackReason: 'provider error: Error' });
  });

  it('calls Workers AI with JSON mode through the AI Gateway', async () => {
    let seen: unknown[] = [];
    const ai = {
      run: async (...args: unknown[]) => {
        seen = args;
        return { response: good };
      },
    } as unknown as Ai;
    const out = await summarizeGrounded(new WorkersAISummarizer(ai, '@cf/meta/llama-3.3-70b-instruct-fp8-fast', 'datatrust'), ev);
    expect(out.fallback).toBe(false);
    expect(out.provider).toBe('workers-ai');
    expect(seen[0]).toBe('@cf/meta/llama-3.3-70b-instruct-fp8-fast');
    const inputs = seen[1] as {
      response_format: { type: string; json_schema: Record<string, unknown> };
      temperature: number;
      messages: ChatMessage[];
    };
    expect(inputs.response_format.type).toBe('json_schema');
    expect(inputs.response_format.json_schema).not.toHaveProperty('$schema');
    expect(inputs.response_format.json_schema).toMatchObject({ type: 'object', required: expect.arrayContaining(['title']) });
    expect(inputs.temperature).toBe(0.1);
    expect(seen[2]).toEqual({ gateway: { id: 'datatrust', skipCache: false } });
  });

  it('calls the local OpenAI-compatible server with thinking disabled and deterministic decoding', async () => {
    let body: Record<string, unknown> = {};
    let url = '';
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      url = String(input);
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(good) } }] }));
    }) as typeof fetch;
    const out = await summarizeGrounded(new OpenAICompatSummarizer('http://127.0.0.1:8160/', fakeFetch), ev);
    expect(url).toBe('http://127.0.0.1:8160/v1/chat/completions');
    expect(body).toMatchObject({ response_format: { type: 'json_object' }, chat_template_kwargs: { enable_thinking: false }, temperature: 0, seed: 7 });
    expect(out.provider).toBe('openai-compatible-local');
    expect(out.fallback).toBe(false);
  });

  it('never puts sample-key tokens back into identifiers or PII into the prompt', async () => {
    const out = await summarizeGrounded(new TemplateSummarizer(), ev);
    const text = JSON.stringify(out.prompt);
    expect(text).not.toMatch(/@example\.com/);
    expect(text).not.toMatch(/\+1-555-/);
  });
});

describe('summarizer factory', () => {
  const env = baseEnv as unknown as AppEnv;

  it('uses the template locally by default and the local LLM when asked', () => {
    expect(createSummarizer({ ...env, SUMMARIZER: 'template' }).provider).toBe('template');
    expect(createSummarizer({ ...env, SUMMARIZER: 'openai-compatible-local' }).provider).toBe('openai-compatible-local');
  });

  it('refuses anything but Workers AI in production', () => {
    expect(() => createSummarizer({ ...env, ENVIRONMENT: 'production', SUMMARIZER: 'template' })).toThrow(/workers-ai/);
    expect(() => createSummarizer({ ...env, ENVIRONMENT: 'production', SUMMARIZER: 'workers-ai' })).toThrow(/AI binding/);
    const ai = { run: async () => ({}) } as unknown as Ai;
    expect(createSummarizer({ ...env, ENVIRONMENT: 'production', SUMMARIZER: 'workers-ai', AI: ai }).provider).toBe('workers-ai');
  });
});

describe('recovery commands', () => {
  it('suggests a BigQuery time-travel copy for a table and a snapshot restore locally', () => {
    const rel = s01.relations;
    const ranked = [{ rank: 1, node: 'model.datatrust.fct_hires', kind: 'model' as const, score: 1, features: { coverage: 1, ownAnomaly: 1, changed: 0, unexplainedPass: 0, distance: 0 }, columns: [], probes: [] }];
    const bq = recoveryCommands({ target: 'bigquery', runId: 'run_x', ranked, relations: rel, now: Date.UTC(2026, 9, 10) });
    expect(bq[0]!.command).toMatch(/^bq cp \S+:marts\.fct_hires@\d+ \S+:marts\.fct_hires_restored_\d{14}$/);
    const local = recoveryCommands({ target: 'duckdb', runId: 'run_x', ranked, relations: rel });
    expect(local[0]!.command).toBe('uv run datatrust restore --from-snapshot <last green run id> fct_hires');
  });
});
