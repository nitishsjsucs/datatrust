import { describe, expect, it } from 'vitest';
import { findUnsanitized, sanitizeProbeResult, tokenize, TOKEN_RE } from '../src/evidence/sanitize';
import type { ProbeResult, RelationsMap } from '../src/types';

const KEY = 'test-key-0123456789abcdef';
const relations: RelationsMap = {
  project: 'datatrust',
  dialect: 'duckdb',
  nodes: {
    n: {
      uniqueId: 'n',
      kind: 'model',
      name: 'n',
      schema: 's',
      identifier: 'n',
      checksum: null,
      materialization: 'table',
      meta: {},
      columns: {
        employee_id: { classification: 'identifier', entity: 'emp' },
        pay_month: { classification: 'internal' },
        work_email: { classification: 'pii' },
        base_salary_usd: { classification: 'compensation' },
        currency: { classification: 'public' },
      },
    },
  },
};

const raw = (over: Partial<ProbeResult> = {}): ProbeResult => ({
  probeId: 'p',
  probe: 'dup_key_rate',
  node: 'n',
  columns: ['employee_id', 'pay_month'],
  metric: 'duplicate_row_rate',
  value: 0.01,
  anomaly: 1,
  sql: ['select 1'],
  dialect: 'duckdb',
  status: 'ok',
  sampleKeys: [
    { employee_id: 1042, pay_month: '2025-04-01', work_email: 'ava.hale.1042@example.com', base_salary_usd: 123456.78 },
  ],
  details: { n_rows: 100, currency: 'INR', note: 'Ava Hale earns 123456' },
  error: null,
  ...over,
});

describe('sanitizer', () => {
  it('tokenizes identifiers with HMAC and an entity prefix', async () => {
    const t = await tokenize(KEY, 'emp', 1042);
    expect(t).toMatch(TOKEN_RE);
    expect(t.startsWith('emp_')).toBe(true);
    expect(await tokenize(KEY, 'emp', 1042)).toBe(t); // deterministic
    expect(await tokenize(KEY, 'emp', 1043)).not.toBe(t);
    expect(await tokenize('another-key-0123456789', 'emp', 1042)).not.toBe(t);
  });

  it('drops PII and compensation values and free text, keeps internal values and counts', async () => {
    const s = await sanitizeProbeResult(raw(), relations, { key: KEY });
    expect(s.sampleKeys).toHaveLength(1);
    const sample = s.sampleKeys[0]!;
    expect(sample['employee_id']).toMatch(/^emp_[0-9a-f]{10}$/);
    expect(sample['pay_month']).toBe('2025-04-01');
    expect(sample).not.toHaveProperty('work_email');
    expect(sample).not.toHaveProperty('base_salary_usd');
    expect(s.details).toEqual({ n_rows: 100, currency: 'INR' });
    const text = JSON.stringify(s);
    expect(text).not.toContain('1042');
    expect(text).not.toContain('example.com');
    expect(text).not.toContain('123456');
    expect(findUnsanitized([s], relations)).toEqual([]);
  });

  it('reduces error text to a class name', async () => {
    const s = await sanitizeProbeResult(raw({ status: 'error', error: "Could not convert '85,000'" }), relations, { key: KEY });
    expect(s.error).toBe('Error');
  });

  it('refuses a short key', async () => {
    await expect(sanitizeProbeResult(raw(), relations, { key: 'short' })).rejects.toThrow(/at least 16/);
  });

  it('flags untokenized identifiers, sampled PII, emails and free text (Worker re-check)', () => {
    const v = findUnsanitized([raw()], relations);
    const reasons = v.map((x) => `${x.path}: ${x.reason}`);
    expect(reasons).toContain('sampleKeys[0].employee_id: identifier is not an HMAC token');
    expect(reasons.some((r) => r.includes('work_email'))).toBe(true);
    expect(reasons.some((r) => r.includes('email address'))).toBe(true);
    expect(reasons).toContain('details.note: free text detail');
  });
});
