import { describe, expect, it } from 'vitest';
import type { SanitizedEvidence } from '../src/evidence/evidence';
import { buildPrompt, buildRepairPrompt } from '../src/summary/prompt';
import { renderSummary } from '../src/summary/render';
import type { IncidentSummary } from '../src/summary/schema';
import { templateDraft } from '../src/summary/template';
import { validateSummary } from '../src/summary/validate';

const ev: SanitizedEvidence = {
  incidentId: 'inc_run_x_checks_00000000',
  runId: 'run_x',
  trigger: 'checks',
  failingChecks: [
    {
      key: 'check.u05',
      checkId: 'U05',
      category: 'uniqueness',
      kind: 'data_test',
      status: 'fail',
      failures: 7,
      node: 'model.datatrust.fct_hires',
      columns: ['application_id'],
    },
  ],
  candidates: [
    {
      key: 'candidate.1',
      rank: 1,
      node: 'source.datatrust.raw.hires',
      score: 0.6166,
      coverage: 1,
      ownAnomaly: 1,
      changed: 0,
      unexplainedPass: 0.83,
      distance: 2,
      columns: ['application_id'],
      probes: ['dup_key_rate:source.datatrust.raw.hires:application_id'],
    },
    {
      key: 'candidate.2',
      rank: 2,
      node: 'model.datatrust.fct_hires',
      score: 0.4,
      coverage: 1,
      ownAnomaly: 0,
      changed: 0,
      unexplainedPass: 0,
      distance: 0,
      columns: ['application_id'],
      probes: [],
    },
  ],
  probes: [
    {
      key: 'dup_key_rate.raw_hires.application_id',
      probeId: 'dup_key_rate:source.datatrust.raw.hires:application_id',
      probe: 'dup_key_rate',
      node: 'source.datatrust.raw.hires',
      columns: ['application_id'],
      metric: 'duplicate_row_rate',
      value: 0.0191,
      anomaly: 1,
      sql: ['select 1'],
      sampleKeys: [{ application_id: 'app_f28e39994a' }],
    },
  ],
};

const good = (): IncidentSummary => ({
  title: 'Duplicate hires in raw_hires break U05',
  impact: 'U05 found {ev:check.u05.failures} duplicated application ids in fct_hires.',
  suspectedRootCause: { node: 'source.datatrust.raw.hires', column: 'application_id', confidence: 'high' },
  reasoning: [
    'The duplicate rate on raw_hires.application_id is {ev:dup_key_rate.raw_hires.application_id.value}.',
    'Sample key app_f28e39994a appears more than once; the top three candidates agree.',
  ],
  evidenceRefs: ['check.u05', 'candidate.1', 'dup_key_rate.raw_hires.application_id'],
  diagnosticSqlIds: ['dup_key_rate.raw_hires.application_id'],
  nextSteps: ['Deduplicate the HRIS hires extract before loading.'],
});

describe('grounding validator', () => {
  it('accepts a grounded draft, and rendering then fills in evidence numbers', () => {
    const v = validateSummary(good(), ev);
    expect(v.violations).toEqual([]);
    expect(v.ok).toBe(true);
    const rendered = renderSummary(good(), ev);
    expect(rendered.impact).toBe('U05 found 7 duplicated application ids in fct_hires.');
    expect(rendered.reasoning[0]).toContain('1.9%');
  });

  it('rejects a bare digit outside a placeholder', () => {
    const d = { ...good(), impact: 'U05 found 7 duplicated application ids.' };
    expect(validateSummary(d, ev).violations).toContain('impact: contains the number "7" outside a placeholder');
  });

  it('rejects an unknown placeholder key or field', () => {
    const d = { ...good(), reasoning: ['Rate {ev:dup_key_rate.raw_hires.application_id.median}.', 'See {ev:check.u99.failures}.'] };
    const v = validateSummary(d, ev);
    expect(v.violations.filter((x) => x.includes('unknown placeholder'))).toHaveLength(2);
  });

  it('allows spelled-out quantities and known identifiers containing digits', () => {
    const d = { ...good(), title: 'Check U05: three candidates, top one is raw_hires' };
    expect(validateSummary(d, ev).ok).toBe(true);
  });

  it('reads a candidate key as that candidate node', () => {
    const d = good();
    d.suspectedRootCause.node = 'candidate.1';
    const v = validateSummary(d, ev);
    expect(v.ok).toBe(true);
    expect(v.summary!.suspectedRootCause.node).toBe('source.datatrust.raw.hires');
  });

  it('requires the root cause to be a top-five candidate', () => {
    const d = good();
    d.suspectedRootCause.node = 'model.datatrust.dim_employee';
    expect(validateSummary(d, ev).violations[0]).toMatch(/not one of the top five/);
  });

  it('rejects unknown evidence refs and SQL ids', () => {
    const d = { ...good(), evidenceRefs: ['check.u05', 'made.up'], diagnosticSqlIds: ['nope'] };
    const v = validateSummary(d, ev).violations;
    expect(v).toContain('evidenceRefs: unknown key "made.up"');
    expect(v).toContain('diagnosticSqlIds: unknown id "nope"');
  });

  it('rejects PII and untokenized identifiers', () => {
    const d = {
      ...good(),
      reasoning: ['Contact ava.hale.one@example.com about it.', 'Call +one.', 'employee_id = 1042 is duplicated.'],
    };
    const v = validateSummary(d, ev).violations;
    expect(v.some((x) => x.includes('email address'))).toBe(true);
    expect(v.some((x) => x.includes('untokenized identifier'))).toBe(true);
  });

  it('rejects schema violations (extra keys, wrong types)', () => {
    expect(validateSummary({ ...good(), extra: true }, ev).ok).toBe(false);
    expect(validateSummary({ ...good(), reasoning: 'text' }, ev).ok).toBe(false);
    expect(validateSummary('not json', ev).ok).toBe(false);
  });
});

describe('template summarizer and prompts', () => {
  it('produces a draft that passes grounding by construction', () => {
    const d = templateDraft(ev);
    expect(validateSummary(d, ev).violations).toEqual([]);
    expect(d.suspectedRootCause).toEqual({ node: 'source.datatrust.raw.hires', column: 'application_id', confidence: 'high' });
    expect(renderSummary(d, ev).impact).toContain('7 failing rows');
  });

  it('lists evidence keys and fields but no values in the prompt', () => {
    const text = buildPrompt(ev).map((m) => m.content).join('\n');
    expect(text).toContain('dup_key_rate.raw_hires.application_id');
    expect(text).toContain('fields: failures');
    expect(text).not.toContain('0.0191');
    expect(text).not.toContain('0.6166');
    expect(text).not.toMatch(/\b7 /);
  });

  it('quotes the exact violations in the repair prompt', () => {
    const msgs = buildRepairPrompt(ev, '{"title":"x"}', ['impact: contains the number "7" outside a placeholder']);
    expect(msgs.at(-1)!.content).toContain('impact: contains the number "7" outside a placeholder');
    expect(msgs.at(-2)!.role).toBe('assistant');
  });
});
