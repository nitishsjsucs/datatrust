/**
 * Start-up warm-up (SPEC 28.5.4 applied to code paths). V8 compiles a function the first time it runs, so
 * the first request in a fresh isolate paid for compiling the zod parsers, the router and the lineage
 * code: about 4 ms of a cold request on Apple silicon, likely twice that on the edge's x86 CPUs, against the
 * Free plan's 10 ms per request. Running each parser once on a tiny synthetic input at module scope moves
 * that compile work into Worker start-up (1 s limit). No I/O, and it never throws; the Access check is the
 * one asynchronous part (WebCrypto), and it settles at start-up too (checked under `wrangler dev`).
 */
import { buildLineageGraph, edgesFromEvent, findUnsanitized, makeResolver, RunEventSchema, type RelationsMap } from '@datatrust/rca';
import { createLocalJWKSet, jwtVerify } from 'jose';
import type { Hono } from 'hono';
import type { HonoEnv } from './hono';
import type { AppEnv } from './env';
import { principalFrom } from './auth/access';
import { parseRoleMap, rolesFor } from './auth/roles';
import { checkResultsMessage } from './queues/check-results';
import { ArtifactSchema, CompleteSchema, InvestigateMessage, LineageBundleSchema } from './schemas';
import { schemaProblems } from './sinks/event-sink';

export const warmUpRelations: RelationsMap = {
  nodes: {
    'source.w.raw.a': { uniqueId: 'source.w.raw.a', kind: 'source', schema: 'raw', identifier: 'a', name: 'a', relation: 'raw.a', columns: { x: { name: 'x', classification: 'identifier' } } },
    'model.w.b': { uniqueId: 'model.w.b', kind: 'model', schema: 'staging', identifier: 'b', name: 'b', relation: 'staging.b', columns: { x: { name: 'x', classification: 'identifier' } } },
  },
} as unknown as RelationsMap;

export const warmUpEvent = {
  eventType: 'COMPLETE',
  eventTime: '2026-01-01T00:00:00.000Z',
  run: { runId: '00000000-0000-4000-8000-000000000000' },
  job: { namespace: 'dbt', name: 'w.b' },
  inputs: [{ namespace: 'duckdb://w', name: 'w.raw.a' }],
  outputs: [
    {
      namespace: 'duckdb://w',
      name: 'w.staging.b',
      facets: { columnLineage: { fields: { x: { inputFields: [{ namespace: 'duckdb://w', name: 'w.raw.a', field: 'x' }] } } } },
    },
  ],
};

export const warmUpCheck = {
  checkId: 'W01',
  testName: 'dq_w01',
  category: 'uniqueness',
  kind: 'data_test',
  status: 'pass',
  failures: 0,
  node: 'model.w.b',
  columns: ['x'],
  message: null,
};

export const warmUpProbe = {
  probeId: 'dup_key_rate:model.w.b:x',
  probe: 'dup_key_rate',
  node: 'model.w.b',
  columns: ['x'],
  metric: 'dup_key_rate',
  value: 0,
  anomaly: 0,
  sql: ['select 1'],
  dialect: 'duckdb',
  status: 'ok',
  sampleKeys: [{ x: 'emp_0123456789' }],
  details: { n: 1 },
};

/**
 * A throwaway RS256 key and a token signed with it, made once for the warm-up (the private key was discarded).
 * Nothing trusts this key: production verifies against Cloudflare Access's JWKS and local runs against the
 * keys from `npm run dev:keys`, so the token opens nothing. It lets start-up run jose's verification code
 * (base64url, JSON, key import, signature, claims), which was most of a cold request's Access check.
 */
export const warmUpJwks = {
  keys: [
    {
      kty: 'RSA',
      n: 't_vshAGNhBJsR3sjnKhmHqDVBwwjvePMhIlPaTGAIg_ov16tAJAw4pdCmQD9U7tJpIWABaHKaVF61283j5AapbjDXvNiiyU7Rxs_rj7JAhLLHxyXHqzGj0fl-wFJ3fEWb5eW8nP1EHOiQ-7aCgqlthVd3Kq8Rzk6hgsL5ZZdW-4gD-pHddw6KhRd0iE5DTA8M-VRmDVRcuPcOjrjIgNBBRNz71BNZ1O_tP3WuDTOWERwAO6HK4QtKmPF3ROlSOEPjo6Oig33FeEGwgk27vg97PbIEGhcRy-e3lbnJL-ciq8dn_jZdGHE2hzfdOzQkj6ezITSsHbLWW9TVuYvoCD_aw',
      e: 'AQAB',
      kid: 'warmup',
      alg: 'RS256',
      use: 'sig',
    },
  ],
};
export const warmUpToken =
  'eyJhbGciOiJSUzI1NiIsImtpZCI6Indhcm11cCJ9.eyJjb21tb25fbmFtZSI6Indhcm11cC5pbnZhbGlkIiwic3ViIjoiIiwiaXNzIjoiaHR0cHM6Ly93YXJtdXAuaW52YWxpZCIsImF1ZCI6Indhcm11cCIsImlhdCI6MTc2NzIyNTYwMCwiZXhwIjoxNzY3MjI5MjAwfQ.IdHz43aJiS28cdmxn8HUn6MM98BDZsgJd6npdbgsk4M-JkpRK90p4BD8pCBfYfyObjUV1bnOSc3lkMiniKBaYAJybsMxwYnIDBW0OzDMreAYPLC7kmc292o-6XCMPsmEavnnDAD-63pYLK9ZO7mp4__xtj4UX6a6zsoL52-cGCgN_9TpPdDrDlYSh9KZsfL_YDDBLJ-AMEGIg9rqIkp9N8ZzEvfJLtwM-sjCKesrJFGr6HQvE0tji9dkiyoaJPKdjLrXhOajp52tKB7Rv7KV8vyuE5ZVTCP-f_0VsfWOL-b0qUFkZbaFw_ya03SUP5cah1I8-rBnzJmNKXTRWpUbSQ';
/** Inside the token's one-hour validity (issued 2026-01-01T00:00:00Z), so the claim checks run too. */
const WARM_UP_NOW = new Date(1767225600 * 1000 + 60_000);

/**
 * jose verification and the role lookup on the embedded token; resolves true when it verified. A local key
 * set: production's remote set (createRemoteJWKSet) cannot be warmed at start-up, because its fetch timeout
 * (AbortSignal.timeout) is a timer, which workerd refuses in global scope (seen under `wrangler dev` on
 * 2026-10-11: the first /healthz then reported warm: false). The CPU harness measures that cold path.
 */
export function warmAccess(): Promise<boolean> {
  return jwtVerify(warmUpToken, createLocalJWKSet(warmUpJwks), {
    issuer: 'https://warmup.invalid',
    audience: 'warmup',
    algorithms: ['RS256'],
    currentDate: WARM_UP_NOW,
  }).then(
    ({ payload }) => {
      const who = principalFrom(payload);
      return who !== null && rolesFor(parseRoleMap('{"serviceTokens":{"warmup.invalid":["viewer"]}}'), who.kind, who.id).length === 1;
    },
    () => false,
  );
}

/**
 * The asynchronous part of the warm-up (jose's verification, WebCrypto). `warmedUp()` turns true once it has
 * resolved; /healthz reports it, so the first health check after start-up shows whether the warm-up settled
 * before that request's handler ran (scripts/dev-up.sh records it and bench-e2e asserts it under workerd).
 */
let accessWarm: Promise<boolean> = Promise.resolve(false);
let accessWarmDone = false;

export function warmedUp(): boolean {
  return accessWarmDone;
}

/** Resolves when the asynchronous warm-up has settled (the CPU harness counts it as start-up). */
export function warmUpSettled(): Promise<boolean> {
  return accessWarm;
}

/** The Hono request pipeline (context, middleware, JSON response) for an unauthenticated health check. */
function warmRequest(app: Pick<Hono<HonoEnv>, 'fetch'>): void {
  const env = { ENVIRONMENT: 'local', VERSION: 'warmup' } as unknown as AppEnv;
  const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  const out = app.fetch(new Request('http://warmup.invalid/healthz'), env, ctx);
  if (out instanceof Promise) out.catch(() => {});
}

export function warmUp(router?: Pick<Hono['router'], 'match'>, app?: Pick<Hono<HonoEnv>, 'fetch'>): void {
  try {
    const parsed = RunEventSchema.parse(warmUpEvent);
    edgesFromEvent(parsed, makeResolver(warmUpRelations));
    buildLineageGraph([warmUpEvent], warmUpRelations);
    CompleteSchema.safeParse({
      status: 'completed',
      checkResults: [warmUpCheck],
      probeResults: [warmUpProbe],
      expectedLineageEvents: 1,
    });
    checkResultsMessage({ runId: 'w', checkResults: [warmUpCheck] });
    LineageBundleSchema.safeParse({ runId: 'w', events: [{ eventId: 'e', r2Key: 'k' }] });
    InvestigateMessage.safeParse({ runId: 'w', incidentId: 'i', trigger: 'checks' });
    ArtifactSchema.safeParse({ kind: 'relations', data: {} });
    findUnsanitized([warmUpProbe] as never, warmUpRelations);
    schemaProblems({ event_id: 'e' });
    router?.match('GET', '/healthz');
    router?.match('POST', '/api/v1/lineage');
    if (app) warmRequest(app);
    // Asynchronous (WebCrypto); in workerd it settles during start-up, before the first request (checked by
    // the first /healthz of scripts/dev-up.sh, asserted in scripts/bench-e2e.sh).
    accessWarm = warmAccess().then((ok) => {
      accessWarmDone = ok;
      return ok;
    });
  } catch {
    // A warm-up problem must never stop the Worker from starting.
  }
}
