/**
 * Production runs on the Cloudflare Workers Free plan only (SPEC 28, ADR-0008). These tests pin the rendered
 * production configuration: no Paid-only feature, and exactly the five datatrust-* queues with the consumer
 * settings the Free budget assumes (SPEC 28.5.1, 28.5.2, 28.7).
 */
import { describe, expect, it } from 'vitest';
import localText from '../wrangler.jsonc?raw';
import templateText from '../wrangler.prod.template.jsonc?raw';
import testText from '../wrangler.test.jsonc?raw';
import { QUEUES } from '../src/queues/router';

/** JSONC to JSON: drop // and block comments outside strings (URLs inside strings keep their slashes). */
function parseJsonc(text: string): Record<string, unknown> {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === '\\') out += text[++i] ?? '';
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1;
    } else out += ch;
  }
  return JSON.parse(out) as Record<string, unknown>;
}

/** The template as `render-prod-config.mjs --placeholders` renders it. */
function rendered(): Record<string, unknown> {
  const text = templateText
    .replaceAll('${D1_DATABASE_ID}', '00000000-0000-4000-8000-000000000001')
    .replaceAll('${ACCESS_TEAM_DOMAIN}', 'https://unset.cloudflareaccess.com');
  expect(text).not.toContain('${');
  return parseJsonc(text);
}

interface Consumer {
  queue: string;
  max_batch_size: number;
  max_batch_timeout: number;
  max_retries?: number;
  dead_letter_queue?: string;
}
interface QueuesConfig {
  producers: Array<{ binding: string; queue: string }>;
  consumers: Consumer[];
}

const FIVE = ['datatrust-check-results', 'datatrust-lineage-events', 'datatrust-investigate', 'datatrust-audit-events', 'datatrust-dlq'];

describe('production configuration fits the Workers Free plan', () => {
  it('uses no Paid-only feature', () => {
    const cfg = rendered();
    for (const key of ['pipelines', 'limits', 'triggers', 'tail_consumers', 'logpush', 'durable_objects']) {
      expect(cfg, key).not.toHaveProperty(key);
    }
    // Durable Objects on Free must use SQLite storage; none exist today, and any migration must say so.
    for (const m of (cfg['migrations'] as Array<Record<string, unknown>> | undefined) ?? []) {
      expect(Object.keys(m).filter((k) => k !== 'tag' && k !== 'new_sqlite_classes')).toEqual([]);
    }
    expect(cfg['ai']).toEqual({ binding: 'AI' });
    expect(cfg['workers_dev']).toBe(true);
    expect(cfg['preview_urls']).toBe(false);
  });

  it('declares exactly the five datatrust-* queues, a DLQ on every consumer but the DLQ, and the audit settings', () => {
    const q = rendered()['queues'] as QueuesConfig;
    expect(q.consumers.map((c) => c.queue).sort()).toEqual([...FIVE].sort());
    expect(Object.values(QUEUES).sort()).toEqual([...FIVE].sort());
    expect(q.producers).toEqual([
      { binding: 'CHECK_RESULTS_Q', queue: 'datatrust-check-results' },
      { binding: 'LINEAGE_Q', queue: 'datatrust-lineage-events' },
      { binding: 'INVESTIGATE_Q', queue: 'datatrust-investigate' },
      { binding: 'AUDIT_Q', queue: 'datatrust-audit-events' },
    ]);
    for (const c of q.consumers) {
      if (c.queue === 'datatrust-dlq') expect(c.dead_letter_queue).toBeUndefined();
      else {
        expect(c.dead_letter_queue, c.queue).toBe('datatrust-dlq');
        expect(c.max_retries, c.queue).toBe(3);
      }
      // Free plan: max_batch_size up to 100, max_batch_timeout up to 60 s.
      expect(c.max_batch_size).toBeLessThanOrEqual(100);
      expect(c.max_batch_timeout).toBeLessThanOrEqual(60);
    }
    const audit = q.consumers.find((c) => c.queue === 'datatrust-audit-events')!;
    expect([audit.max_batch_size, audit.max_batch_timeout]).toEqual([10, 30]);
  });

  it('settles lake objects for 120 s in production', () => {
    const vars = rendered()['vars'] as Record<string, string>;
    expect(vars['LAKE_SETTLE_SECONDS']).toBe('120');
  });

  it('keeps the local and test configs on the same queues and workflows as production', () => {
    const prod = rendered();
    for (const text of [localText, testText]) {
      const cfg = parseJsonc(text);
      expect(cfg['queues']).toEqual(prod['queues']);
      expect(cfg['workflows']).toEqual(prod['workflows']);
      expect(cfg).not.toHaveProperty('pipelines');
    }
  });
});
