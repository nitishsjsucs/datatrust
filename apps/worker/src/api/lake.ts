/**
 * GET /api/lake/export?after=<key> (role runner, both environments; SPEC 13.1, 28.5.1). Returns the NDJSON of
 * settled `lake/` objects after a key, for `datatrust lake commit`: one R2 list (startAfter, limit 100), then
 * at most 100 objects and 1 MB. An object is settled once its ULID time is LAKE_SETTLE_SECONDS old (120 s in
 * production), so an object that a concurrent consumer writes late, under an earlier key, is never skipped.
 * `x-next-after` names the last key returned (the committer's next cursor).
 */
import { Hono } from 'hono';
import { type HonoEnv, requireRole } from '../hono';
import { ulidTimeMs } from '../ids';

export const LAKE_EXPORT_MAX_OBJECTS = 100;
export const LAKE_EXPORT_MAX_BYTES = 1_000_000;
export const DEFAULT_SETTLE_SECONDS = 120;

export interface LakeExport {
  body: string;
  keys: string[];
  nextAfter: string;
  /** True when more settled objects may follow (the page or a size limit stopped the export). */
  more: boolean;
}

export function settleSeconds(value: string | undefined): number {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(n) && n >= 0 ? n : DEFAULT_SETTLE_SECONDS;
}

export async function exportSettled(
  bucket: R2Bucket,
  opts: { after: string; nowMs: number; settleMs: number },
): Promise<LakeExport> {
  const page = await bucket.list({
    prefix: 'lake/',
    limit: LAKE_EXPORT_MAX_OBJECTS,
    ...(opts.after ? { startAfter: opts.after } : {}),
  });
  const keys: string[] = [];
  let body = '';
  let bytes = 0;
  let nextAfter = opts.after;
  let stop: 'unsettled' | 'size' | 'missing' | null = null;
  for (const o of page.objects) {
    if (o.key <= opts.after) continue;
    const name = o.key.split('/').pop() ?? '';
    const t = ulidTimeMs(name.replace(/\.ndjson$/, ''));
    if (t === null) {
      nextAfter = o.key; // not a lake object written by the consumer: skip it
      continue;
    }
    if (opts.nowMs - t < opts.settleMs) {
      stop = 'unsettled'; // keys sort by time, so everything after this one is newer still
      break;
    }
    if (keys.length && bytes + o.size > LAKE_EXPORT_MAX_BYTES) {
      stop = 'size';
      break;
    }
    const obj = await bucket.get(o.key);
    if (!obj) {
      stop = 'missing';
      break;
    }
    const text = await obj.text();
    body += text.endsWith('\n') || !text ? text : text + '\n';
    bytes += o.size;
    keys.push(o.key);
    nextAfter = o.key;
  }
  const more = stop === 'size' || (stop === null && page.truncated);
  return { body, keys, nextAfter, more };
}

export const lake = new Hono<HonoEnv>();

lake.get('/export', requireRole('runner'), async (c) => {
  const after = c.req.query('after') ?? '';
  const out = await exportSettled(c.env.ARTIFACTS, {
    after,
    nowMs: Date.now(),
    settleMs: settleSeconds(c.env.LAKE_SETTLE_SECONDS) * 1000,
  });
  return c.body(out.body, 200, {
    'content-type': 'application/x-ndjson',
    'x-next-after': out.nextAfter,
    'x-objects': String(out.keys.length),
    'x-more': out.more ? '1' : '0',
  });
});
