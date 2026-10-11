/**
 * Worker code paths for the CPU budget (SPEC 28.3, 28.7), bundled by scripts/cpu-budget.mjs and run once per
 * fresh Node process. Each path has a `prepare` (not measured: fixtures, fakes, tokens) and a `run` (measured:
 * the code the Worker runs for one request, queue batch or Workflow step). Cloudflare bindings are in-memory
 * fakes, so the figure is DataTrust's own CPU (parsing, validation, hashing, graph work, ranking).
 */
import './jitless';
import {
  buildEvidence,
  buildLineageGraph,
  type CheckResult,
  FROZEN_WEIGHTS,
  planProbes,
  type ProbeResult,
  rankAll,
  type RelationsMap,
  summarizeGrounded,
  TemplateSummarizer,
  traceUpstream,
} from '@datatrust/rca';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import fixture from '../../apps/worker/test/fixtures/investigation.s01.seed101.json';
import { createApp } from '../../apps/worker/src/app';
import type { AppEnv } from '../../apps/worker/src/env';
import { queue } from '../../apps/worker/src/queues/router';
import { auditEvent, auditEventId } from '../../apps/worker/src/sinks/event-sink';
import { warmUp } from '../../apps/worker/src/warmup';

// As in apps/worker/src/index.ts: one app per isolate, warmed at start-up (module scope, not measured).
const app = createApp();
warmUp(app.router, app);

const s01 = fixture as unknown as {
  checks: CheckResult[];
  relations: RelationsMap;
  events: Array<Record<string, unknown>>;
  probeResults: ProbeResult[];
};

// ------------------------------------------------------------------------------------------- fakes

class FakeR2 {
  readonly objects = new Map<string, string>();
  async put(key: string, value: string) {
    this.objects.set(key, typeof value === 'string' ? value : String(value));
    return {};
  }
  async get(key: string) {
    const v = this.objects.get(key);
    return v === undefined ? null : { text: async () => v, json: async () => JSON.parse(v), size: v.length };
  }
  async list() {
    return { objects: [], truncated: false };
  }
}

const RUN_ID = 'run_01CPUBUDGET0000000000000000';
const BUILD_JOB = {
  job_id: `job_${RUN_ID}_build`,
  run_id: RUN_ID,
  kind: 'dbt_build',
  payload_json: '{}',
  status: 'leased',
  lease_token: 'lease',
  lease_owner: 'cpu',
  lease_expires_at: Date.now() + 3_600_000,
  attempts: 1,
  workflow_instance_id: RUN_ID,
  event_type: 'build-complete',
  created_at: '',
  updated_at: '',
};
const DIAG_JOB = { ...BUILD_JOB, job_id: `job_inc_${RUN_ID}_diag`, kind: 'diagnostics', event_type: 'diagnostics-complete' };

/** D1 stand-in: the job lookup returns the leased job; every write succeeds; other reads find nothing. */
function fakeD1() {
  let job: unknown = BUILD_JOB;
  const statement = (sql: string): D1PreparedStatement => {
    const s = {
      bind: () => s,
      first: async () => (sql.startsWith('SELECT * FROM jobs') ? job : null),
      run: async () => ({ success: true, meta: { changes: 1 } }),
      all: async () => ({ results: [] }),
      raw: async () => [],
    };
    return s as unknown as D1PreparedStatement;
  };
  return {
    setJob: (j: unknown) => void (job = j),
    db: {
      prepare: statement,
      batch: async (stmts: unknown[]) => stmts.map(() => ({ success: true, meta: { changes: 1 } })),
      exec: async () => ({ count: 0, duration: 0 }),
    } as unknown as D1Database,
  };
}

const fakeQueue = () => ({ send: async () => {}, sendBatch: async () => {} }) as unknown as Queue;
const fakeWorkflow = () => ({ get: async () => ({ sendEvent: async () => {} }) }) as unknown as Workflow;

/**
 * Node implements WHATWG Request/Response bodies (undici) and WebCrypto in JavaScript that loads lazily on
 * first use; workerd implements both natively. Warm them on unrelated data, without touching DataTrust, Hono,
 * jose or zod code, so the measurement is not Node start-up (SPEC 28.3 did the same for SHA-256).
 */
async function warmNodePlatform() {
  await crypto.subtle.digest('SHA-256', new TextEncoder().encode('warm'));
  const req = new Request('http://warm/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' });
  await req.clone().arrayBuffer();
  await req.json();
  await new Response('{"b":2}', { headers: { 'content-type': 'application/json' } }).json();
  new URL('http://warm/a?b=c').searchParams.get('b');
  const alg = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
  const kp = (await crypto.subtle.generateKey({ ...alg, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
  const pub = await crypto.subtle.importKey('jwk', jwk, alg, false, ['verify']);
  const data = new TextEncoder().encode('warm');
  await crypto.subtle.verify(alg, pub, await crypto.subtle.sign(alg, kp.privateKey, data), data);
  await crypto.subtle.sign({ name: 'HMAC' }, await crypto.subtle.importKey('raw', data, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), data);
}

async function workerEnv() {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: 'cpu', alg: 'RS256', use: 'sig' };
  const token = await new SignJWT({ common_name: 'cpu-runner.access', sub: '' })
    .setProtectedHeader({ alg: 'RS256', kid: 'cpu' })
    .setIssuer('http://cpu/dev-access')
    .setAudience('datatrust-cpu')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
  const d1 = fakeD1();
  const r2 = new FakeR2();
  const env = {
    ENVIRONMENT: 'local',
    ACCESS_MODE: 'local-jwks',
    SUMMARIZER: 'template',
    ACCESS_ISSUER: 'http://cpu/dev-access',
    ACCESS_AUD: 'datatrust-cpu',
    ACCESS_JWKS_JSON: JSON.stringify({ keys: [jwk] }),
    ROLE_MAP_JSON: JSON.stringify({ emails: {}, serviceTokens: { 'cpu-runner.access': ['runner'] } }),
    EVIDENCE_HMAC_KEY: 'cpu-evidence-key-0123456789abcdef',
    WORKERS_AI_MODEL: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    AI_DAILY_NEURON_CAP: '2000',
    LAKE_SETTLE_SECONDS: '120',
    VERSION: 'cpu',
    DB: d1.db,
    ARTIFACTS: r2 as unknown as R2Bucket,
    CHECK_RESULTS_Q: fakeQueue(),
    LINEAGE_Q: fakeQueue(),
    INVESTIGATE_Q: fakeQueue(),
    AUDIT_Q: fakeQueue(),
    VALIDATION_RUN: fakeWorkflow(),
    INVESTIGATION: fakeWorkflow(),
  } as unknown as AppEnv;
  await r2.put(`runs/${RUN_ID}/relations.json`, JSON.stringify(s01.relations));
  await warmNodePlatform();
  return { env, r2, d1, token };
}

const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

function request(path: string, token: string, body: unknown, headers: Record<string, string> = {}) {
  const text = JSON.stringify(body);
  return new Request(`http://worker${path}`, {
    method: 'POST',
    headers: { 'Cf-Access-Jwt-Assertion': token, 'content-type': 'application/json', 'content-length': String(text.length), ...headers },
    body: text,
  });
}

/** The 10 largest seed-101 model events, the worst case for one lineage POST (SPEC 28.3). */
const largestTen = () => [...s01.events].sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length).slice(0, 10);

/** 68 sanitized probe results, the largest diagnostics completion seen over the 105 test-seed trials. */
function probes68(): ProbeResult[] {
  return Array.from({ length: 68 }, (_, i) => {
    const p = s01.probeResults[i % s01.probeResults.length]!;
    return { ...p, probeId: `${p.probeId}#${i}` };
  });
}

function batch(queueName: string, bodies: unknown[]): MessageBatch<unknown> {
  return {
    queue: queueName,
    messages: bodies.map((body, i) => ({
      id: `m${i}`,
      timestamp: new Date(),
      attempts: 1,
      body,
      ack() {},
      retry() {},
    })),
    ackAll() {},
    retryAll() {},
  } as unknown as MessageBatch<unknown>;
}

// ------------------------------------------------------------------------------------------- paths

export interface CpuPath {
  prepare: () => Promise<() => Promise<unknown>>;
}

export const paths: Record<string, CpuPath> = {
  'POST /api/v1/lineage (10 largest events)': {
    async prepare() {
      const { env, token } = await workerEnv();
      const req = request('/api/v1/lineage', token, largestTen(), {
        'X-DataTrust-Job-Id': BUILD_JOB.job_id,
        'X-DataTrust-Lease-Token': 'lease',
      });
      return async () => {
        const res = await app.fetch(req, env, ctx);
        if (res.status !== 202) throw new Error(`lineage POST answered ${res.status}`);
      };
    },
  },
  'lineage bundle consumer (10 largest events)': {
    async prepare() {
      const { env, r2 } = await workerEnv();
      const events = largestTen().map((ev, i) => ({ eventId: `e${i}`, r2Key: `lineage/${RUN_ID}/e${i}.json`, ev }));
      for (const e of events) await r2.put(e.r2Key, JSON.stringify(e.ev));
      const b = batch('datatrust-lineage-events', [{ runId: RUN_ID, events: events.map(({ eventId, r2Key }) => ({ eventId, r2Key })) }]);
      return () => queue(b, env);
    },
  },
  'relations upload (42 nodes)': {
    async prepare() {
      const { env, token } = await workerEnv();
      const req = request(`/api/runner/jobs/${BUILD_JOB.job_id}/artifacts`, token, { kind: 'relations', data: s01.relations }, {
        'X-DataTrust-Lease-Token': 'lease',
      });
      return async () => {
        const res = await app.fetch(req, env, ctx);
        if (res.status !== 200) throw new Error(`relations upload answered ${res.status}`);
      };
    },
  },
  'build completion (41 check results)': {
    async prepare() {
      const { env, token } = await workerEnv();
      const checks = [...s01.checks, { ...s01.checks[0]!, checkId: 'contract:stg_compensation', kind: 'schema_contract' as const }];
      const req = request(`/api/runner/jobs/${BUILD_JOB.job_id}/complete`, token, { status: 'completed', checkResults: checks, expectedLineageEvents: 140 }, {
        'X-DataTrust-Lease-Token': 'lease',
      });
      return async () => {
        const res = await app.fetch(req, env, ctx);
        if (res.status !== 200) throw new Error(`build completion answered ${res.status}`);
      };
    },
  },
  'diagnostics completion (68 probe results)': {
    async prepare() {
      const { env, token, d1 } = await workerEnv();
      d1.setJob(DIAG_JOB);
      const req = request(`/api/runner/jobs/${DIAG_JOB.job_id}/complete`, token, { status: 'completed', probeResults: probes68() }, {
        'X-DataTrust-Lease-Token': 'lease',
      });
      return async () => {
        const res = await app.fetch(req, env, ctx);
        if (res.status !== 200) throw new Error(`diagnostics completion answered ${res.status}`);
      };
    },
  },
  'check-results consumer (10 messages of 41)': {
    async prepare() {
      const { env } = await workerEnv();
      const bodies = Array.from({ length: 10 }, (_, i) => ({ runId: `${RUN_ID}${i}`, checkResults: s01.checks }));
      const b = batch('datatrust-check-results', bodies);
      return () => queue(b, env);
    },
  },
  'audit consumer (10 messages of 50 events)': {
    async prepare() {
      const { env } = await workerEnv();
      const bodies = Array.from({ length: 10 }, (_, m) => ({
        events: Array.from({ length: 50 }, (_, i) =>
          auditEvent(env, 'check_result', RUN_ID, { event_id: auditEventId.checkResult(RUN_ID, `C${m}_${i}`), check_id: `C${i}`, status: 'pass', payload: { failures: 0, columns: ['employee_id'] } }),
        ),
      }));
      const b = batch('datatrust-audit-events', bodies);
      return () => queue(b, env);
    },
  },
  'workflow step trace-lineage + plan-probes': {
    async prepare() {
      const graph = buildLineageGraph(s01.events, s01.relations);
      const checks = JSON.parse(JSON.stringify(s01.checks)) as CheckResult[];
      return async () => {
        const trace = traceUpstream(checks, graph, 'column');
        return planProbes(trace.candidates, graph, s01.relations);
      };
    },
  },
  'workflow step rank': {
    async prepare() {
      const graph = buildLineageGraph(s01.events, s01.relations);
      return async () =>
        rankAll({ checks: s01.checks, graph, relations: s01.relations, probeResults: s01.probeResults, baselineChecksums: null, weights: FROZEN_WEIGHTS });
    },
  },
  'workflow steps sanitize + summarize (template)': {
    async prepare() {
      const graph = buildLineageGraph(s01.events, s01.relations);
      const ranked = rankAll({ checks: s01.checks, graph, relations: s01.relations, probeResults: s01.probeResults }).ranked;
      return async () => {
        const ev = buildEvidence({ incidentId: 'inc_cpu', runId: RUN_ID, trigger: 'checks', checks: s01.checks, ranked, probeResults: s01.probeResults, relations: s01.relations });
        return summarizeGrounded(new TemplateSummarizer(), ev);
      };
    },
  },
};
