import { createMiddleware } from 'hono/factory';
import type { Principal, Role } from './auth/roles';
import { hasRole } from './auth/roles';
import type { AppEnv } from './env';

export type HonoEnv = { Bindings: AppEnv; Variables: { principal: Principal } };

export const requireRole = (...roles: Role[]) =>
  createMiddleware<HonoEnv>(async (c, next) => {
    const p = c.get('principal');
    if (!p || !hasRole(p, roles)) return c.json({ error: 'forbidden' }, 403);
    await next();
  });
