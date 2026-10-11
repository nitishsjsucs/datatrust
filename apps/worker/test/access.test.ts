import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { base64url, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import type { AppEnv } from '../src/env';
import {
  humanClaims,
  type Keys,
  makeKeys,
  mint,
  OPERATOR,
  RUNNER_CLIENT_ID,
  serviceClaims,
  testEnv,
  VIEWER,
} from './helpers/keys';

const app = createApp();

async function call(path: string, env: AppEnv, token?: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token !== undefined) headers.set('Cf-Access-Jwt-Assertion', token);
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`http://worker${path}`, { ...init, headers }), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

let keys: Keys;
let other: Keys;
let env: AppEnv;

beforeAll(async () => {
  keys = await makeKeys();
  other = await makeKeys(); // same kid, different key
  env = testEnv(keys);
});

describe('Access JWT verification (fail closed)', () => {
  it('accepts a valid human token and resolves roles from the email', async () => {
    const res = await call('/api/whoami', env, await mint(keys, humanClaims(OPERATOR)));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: 'human', id: OPERATOR, roles: ['operator', 'viewer'] });
  });

  it('accepts the documented service-token payload (common_name, empty sub, no email)', async () => {
    const res = await call('/api/whoami', env, await mint(keys, serviceClaims()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: 'service', id: RUNNER_CLIENT_ID, roles: ['runner'] });
  });

  it('rejects a wrong audience', async () => {
    const res = await call('/api/whoami', env, await mint(keys, humanClaims(OPERATOR), { aud: 'other-app' }));
    expect(res.status).toBe(401);
  });

  it('rejects a wrong issuer', async () => {
    const res = await call('/api/whoami', env, await mint(keys, humanClaims(OPERATOR), { iss: 'https://evil.example.com' }));
    expect(res.status).toBe(401);
  });

  it('rejects an expired token', async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const res = await call('/api/whoami', env, await mint(keys, humanClaims(OPERATOR), { exp: past }));
    expect(res.status).toBe(401);
  });

  it('rejects an unknown kid', async () => {
    const res = await call('/api/whoami', env, await mint(keys, humanClaims(OPERATOR), { kid: 'not-in-jwks' }));
    expect(res.status).toBe(401);
  });

  it('rejects a token signed by a different key', async () => {
    const res = await call('/api/whoami', env, await mint(other, humanClaims(OPERATOR)));
    expect(res.status).toBe(401);
  });

  it('rejects alg none', async () => {
    const header = base64url.encode(JSON.stringify({ alg: 'none', typ: 'JWT', kid: 'test-kid-1' }));
    const now = Math.floor(Date.now() / 1000);
    const payload = base64url.encode(
      JSON.stringify({ ...humanClaims(OPERATOR), iss: env.ACCESS_ISSUER, aud: env.ACCESS_AUD, iat: now, exp: now + 600 }),
    );
    const res = await call('/api/whoami', env, `${header}.${payload}.`);
    expect(res.status).toBe(401);
  });

  it('rejects HS256 signed with the public key as the secret (algorithm confusion)', async () => {
    const secret = new TextEncoder().encode(JSON.stringify(keys.publicJwk));
    const token = await new SignJWT(humanClaims(OPERATOR))
      .setProtectedHeader({ alg: 'HS256', kid: 'test-kid-1' })
      .setIssuer(env.ACCESS_ISSUER)
      .setAudience(env.ACCESS_AUD)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(secret);
    const res = await call('/api/whoami', env, token);
    expect(res.status).toBe(401);
  });

  it('rejects a missing header, and gives no detail', async () => {
    const res = await call('/api/whoami', env);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('rejects everything while ACCESS_AUD is unset (first deploy before Access exists)', async () => {
    const res = await call('/api/whoami', { ...env, ACCESS_AUD: 'unset' }, await mint(keys, humanClaims(OPERATOR), { aud: 'unset' }));
    expect(res.status).toBe(401);
  });

  it('enforces roles per route and denies unknown principals', async () => {
    const viewer = await mint(keys, humanClaims(VIEWER));
    const runner = await mint(keys, serviceClaims());
    const stranger = await mint(keys, humanClaims('stranger@example.com'));
    expect((await call('/api/incidents', env, viewer)).status).toBe(200);
    expect((await call('/api/incidents', env, runner)).status).toBe(403);
    expect((await call('/api/whoami', env, stranger)).status).toBe(403);
    expect((await call('/api/whoami', env, await mint(keys, serviceClaims('unknown-client')))).status).toBe(403);
  });
});

describe('production guard', () => {
  it('returns 500 misconfigured on every route when production runs with a stand-in', async () => {
    const prod = { ...env, ENVIRONMENT: 'production' as const };
    for (const path of ['/healthz', '/api/whoami', '/api/incidents']) {
      const res = await call(path, prod, await mint(keys, humanClaims(OPERATOR)));
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'misconfigured' });
    }
  });

  it('requires Access, Workers AI and the audit queue in production', async () => {
    const complete: AppEnv = {
      ...env,
      ENVIRONMENT: 'production',
      ACCESS_MODE: 'cloudflare',
      SUMMARIZER: 'workers-ai',
      ACCESS_TEAM_DOMAIN: 'https://example-team.cloudflareaccess.com',
      AI: {} as Ai,
    };
    expect((await call('/healthz', complete)).status).toBe(200);
    expect((await call('/healthz', { ...complete, SUMMARIZER: 'template' })).status).toBe(500);
    expect((await call('/healthz', { ...complete, AI: undefined })).status).toBe(500);
    expect((await call('/healthz', { ...complete, AUDIT_Q: undefined as unknown as Queue })).status).toBe(500);
    // Without a reachable team JWKS the API still fails closed.
    expect((await call('/api/whoami', { ...complete, ACCESS_TEAM_DOMAIN: 'not-a-url' })).status).toBe(401);
  });
});
