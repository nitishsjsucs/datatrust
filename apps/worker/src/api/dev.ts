/**
 * /api/dev/* exists only when ENVIRONMENT=local (SPEC 13.1). lake-export returns the NDJSON audit events the
 * local R2NdjsonSink wrote, after a cursor, for `datatrust lake sync` (pyiceberg SQL catalog stand-in).
 */
import { Hono } from 'hono';
import { type HonoEnv, requireRole } from '../hono';

export const dev = new Hono<HonoEnv>();

dev.use('*', async (c, next) => {
  if (c.env.ENVIRONMENT !== 'local') return c.json({ error: 'not_found' }, 404);
  await next();
});

dev.get('/lake-export', requireRole('runner'), async (c) => {
  const after = c.req.query('after') ?? '';
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await c.env.ARTIFACTS.list({ prefix: 'lake/', cursor, ...(after ? { startAfter: after } : {}) });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  keys.sort();
  const selected = keys.filter((k) => k > after).slice(0, 500);
  let body = '';
  for (const key of selected) {
    const obj = await c.env.ARTIFACTS.get(key);
    if (obj) body += await obj.text();
  }
  return c.body(body, 200, {
    'content-type': 'application/x-ndjson',
    'x-next-after': selected.at(-1) ?? after,
    'x-objects': String(selected.length),
  });
});
