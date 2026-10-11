/** Hono app: health, Access-verified API routes and role guards (SPEC 13.1, 15). */
import { Hono } from 'hono';
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

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: 'internal' }, 500);
  });
  return app;
}
