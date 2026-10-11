/** Hono app: health, Access-verified API routes and role guards (SPEC 13.1, 15). */
import { Hono } from 'hono';
import { admin } from './api/admin';
import { ai } from './api/ai';
import { alerts } from './api/alerts';
import { evalRoutes } from './api/eval';
import { incidents } from './api/incidents';
import { lake } from './api/lake';
import { lineageRead } from './api/lineage';
import { lineageIngest } from './api/lineage-ingest';
import { runner } from './api/runner';
import { runs } from './api/runs';
import { authenticate } from './auth/access';
import { misconfiguration } from './env';
import type { HonoEnv } from './hono';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function createApp(): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();

  // Startup guard: production never runs with a local stand-in (SPEC 13.10).
  app.use('*', async (c, next) => {
    const problem = misconfiguration(c.env);
    if (problem) {
      console.error(`misconfigured: ${problem}`);
      return c.json({ error: 'misconfigured' }, 500);
    }
    await next();
  });

  app.get('/healthz', (c) => c.json({ ok: true, environment: c.env.ENVIRONMENT, version: c.env.VERSION }));

  // Every /api route requires a verified Access JWT (fail closed, no detail on failure).
  app.use('/api/*', async (c, next) => {
    const outcome = await authenticate(c.req.raw, c.env);
    if (!outcome.ok) return c.json({ error: outcome.status === 401 ? 'unauthorized' : 'forbidden' }, outcome.status);
    c.set('principal', outcome.principal);
    await next();
  });

  // Cross-site request forgery: in production Cloudflare Access turns the browser's CF_Authorization cookie
  // into the verified JWT header, so a form posted from another site by a logged-in operator would arrive
  // authenticated. State-changing calls therefore need a JSON body (a cross-site form cannot send
  // application/json without a CORS preflight, which this Worker never answers) and are refused when the
  // browser marks them cross-site. The runner, the CLI and the smoke always send application/json.
  app.use('/api/*', async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return next();
    if (c.req.header('sec-fetch-site') === 'cross-site') return c.json({ error: 'cross_site' }, 403);
    const type = (c.req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (type !== 'application/json') return c.json({ error: 'unsupported_media_type' }, 415);
    await next();
  });

  app.get('/api/whoami', (c) => c.json(c.get('principal')));
  app.route('/api/runs', runs);
  app.route('/api/incidents', incidents);
  app.route('/api/lineage', lineageRead);
  app.route('/api/runner', runner);
  app.route('/api/v1/lineage', lineageIngest);
  app.route('/api/alerts', alerts);
  app.route('/api/lake', lake);
  app.route('/api/ai', ai);
  app.route('/api/eval', evalRoutes);
  app.route('/api/admin', admin);

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: 'internal' }, 500);
  });
  return app;
}
