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
import { ulid } from '../../apps/worker/src/ids';
import { auditEvent, auditEventId } from '../../apps/worker/src/sinks/event-sink';
import { warmUp, warmUpSettled } from '../../apps/worker/src/warmup';

/** The harness awaits this before it reads the start-up CPU, so the asynchronous warm-up counts as start-up. */
export { warmUpSettled };

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
  async list(opts: { prefix?: string; limit?: number; startAfter?: string } = {}) {
    const keys = [...this.objects.keys()]
      .filter((k) => k.startsWith(opts.prefix ?? '') && (!opts.startAfter || k > opts.startAfter))
      .sort()
      .slice(0, opts.limit ?? 1000);
    return { objects: keys.map((key) => ({ key, size: this.objects.get(key)!.length })), truncated: false };
  }
  async delete(keys: string | string[]) {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.objects.delete(k);
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

/**
 * D1 stand-in: the job lookup returns the leased job; every write succeeds; other reads return what `rows`
 * gives for their SQL (D1 does the SQL work, including json_extract, so rows arrive in their final shape).
 */
function fakeD1(rows: (sql: string) => unknown[] = () => []) {
  let job: unknown = BUILD_JOB;
  const meta = { changes: 1, rows_written: 1 };
  const statement = (sql: string): D1PreparedStatement => {
    const s = {
      bind: () => s,
      first: async () => (sql.startsWith('SELECT * FROM jobs') ? job : (rows(sql)[0] ?? null)),
      run: async () => ({ success: true, meta }),
      all: async () => ({ results: rows(sql) }),
      raw: async () => [],
    };
    return s as unknown as D1PreparedStatement;
  };
  return {
    setJob: (j: unknown) => void (job = j),
    db: {
      prepare: statement,
      batch: async (stmts: unknown[]) => stmts.map(() => ({ success: true, meta })),
      exec: async () => ({ count: 0, duration: 0 }),
    } as unknown as D1Database,
  };
}

const fakeQueue = () => ({ send: async () => {}, sendBatch: async () => {} }) as unknown as Queue;
const fakeWorkflow = () =>
  ({ get: async () => ({ sendEvent: async () => {} }), create: async (o: { id: string }) => ({ id: o.id }) }) as unknown as Workflow;

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

const CPU_TEAM = 'https://cpu.cloudflareaccess.com';

async function workerEnv(opts: { rows?: (sql: string) => unknown[]; cloudflareAccess?: boolean } = {}) {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: 'cpu', alg: 'RS256', use: 'sig' };
  const issuer = opts.cloudflareAccess ? CPU_TEAM : 'http://cpu/dev-access';
  const mintFor = (cn: string) =>
    new SignJWT({ common_name: cn, sub: '' })
      .setProtectedHeader({ alg: 'RS256', kid: 'cpu' })
      .setIssuer(issuer)
      .setAudience('datatrust-cpu')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);
  const token = await mintFor('cpu-runner.access');
  const operatorToken = await mintFor('cpu-operator.access');
  if (opts.cloudflareAccess) {
    // Production verifies against the team's remote JWKS (createRemoteJWKSet): the first request of an isolate
    // fetches it. The fetch is I/O, not CPU; parsing and importing the keys is measured.
    const certs = JSON.stringify({ keys: [jwk] });
    globalThis.fetch = (async () => new Response(certs, { headers: { 'content-type': 'application/json' } })) as typeof fetch;
  }
  const d1 = fakeD1(opts.rows);
  const r2 = new FakeR2();
  const env = {
    ENVIRONMENT: 'local',
    ACCESS_MODE: opts.cloudflareAccess ? 'cloudflare' : 'local-jwks',
    ACCESS_TEAM_DOMAIN: opts.cloudflareAccess ? CPU_TEAM : '',
    SUMMARIZER: 'template',
    ACCESS_ISSUER: 'http://cpu/dev-access',
    ACCESS_AUD: 'datatrust-cpu',
    ACCESS_JWKS_JSON: opts.cloudflareAccess ? '' : JSON.stringify({ keys: [jwk] }),
    ROLE_MAP_JSON: JSON.stringify({
      emails: {},
      serviceTokens: { 'cpu-runner.access': ['runner'], 'cpu-operator.access': ['operator', 'viewer'] },
    }),
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
  return { env, r2, d1, token, operatorToken };
}

const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

function getRequest(path: string, token: string) {
  return new Request(`http://worker${path}`, { headers: { 'Cf-Access-Jwt-Assertion': token } });
}

async function expectStatus(res: Response, status: number, what: string) {
  if (res.status !== status) throw new Error(`${what} answered ${res.status}`);
  await res.arrayBuffer(); // the response body is serialized inside the measured run, as in workerd
}

/** One incident row as the list query returns it, from the S01 fixture (the list reads no JSON column). */
function incidentBriefRows(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    incident_id: `inc_${RUN_ID}_checks_${String(i).padStart(8, '0')}`,
    run_id: RUN_ID,
    trigger: 'checks',
    status: 'open',
    created_at: new Date(Date.UTC(2026, 9, 11, 0, i)).toISOString(),
    top_candidate: 'source.datatrust.raw.hires',
    summary_provider: 'workers-ai',
    summary_fallback: 0,
  }));
}

/** The rows loadLineageGraph's one statement returns for the S01 graph (nodes, then edges). */
function lineageRows() {
  const g = buildLineageGraph(s01.events, s01.relations);
  return [
    ...Object.entries(g.nodes).map(([id, n]) => ({
      t: 'n',
      a: id,
      b: n.kind,
      c: n.relation,
      d: n.checksum,
      e: JSON.stringify({ columns: n.columns, classification: n.classification }),
    })),
    ...g.columnEdges.map((e) => ({ t: 'x', a: e.from.node, b: e.from.column ?? '*', c: e.to.node, d: e.to.column ?? '*', e: null })),
    ...g.datasetEdges.map((e) => ({ t: 'x', a: e.from, b: '*', c: e.to, d: '*', e: null })),
  ];
}

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
  'diagnostics completion, Access with remote JWKS (production)': {
    async prepare() {
      const { env, token, d1 } = await workerEnv({ cloudflareAccess: true });
      d1.setJob(DIAG_JOB);
      const req = request(`/api/runner/jobs/${DIAG_JOB.job_id}/complete`, token, { status: 'completed', probeResults: probes68() }, {
        'X-DataTrust-Lease-Token': 'lease',
      });
      return async () => expectStatus(await app.fetch(req, env, ctx), 200, 'diagnostics completion (remote JWKS)');
    },
  },
  'GET /api/incidents (100 incidents)': {
    async prepare() {
      const rows = incidentBriefRows(100);
      const { env, operatorToken } = await workerEnv({ rows: (sql) => (sql.includes('FROM incidents') ? rows : []) });
      const req = getRequest('/api/incidents', operatorToken);
      return async () => expectStatus(await app.fetch(req, env, ctx), 200, 'incident list');
    },
  },
  'GET /api/lineage/:runId/upstream (S01 graph)': {
    async prepare() {
      const rows = lineageRows();
      const { env, operatorToken } = await workerEnv({ rows: (sql) => (sql.includes('FROM lineage_nodes') ? rows : []) });
      const req = getRequest(`/api/lineage/${RUN_ID}/upstream?node=model.datatrust.metric_payroll_cost_usd_monthly&column=payroll_cost_usd`, operatorToken);
      return async () => expectStatus(await app.fetch(req, env, ctx), 200, 'lineage upstream');
    },
  },
  'GET /api/lake/export (100 objects, 1 MB)': {
    async prepare() {
      const { env, token, r2 } = await workerEnv();
      // 100 settled lake objects of 9,990 bytes: the export's per-call limits (100 objects, 1 MB).
      const line = JSON.stringify(
        auditEvent(env, 'check_result', RUN_ID, { event_id: auditEventId.checkResult(RUN_ID, 'C01'), check_id: 'C01', status: 'pass', payload: { failures: 0 } }),
      );
      const body = (line + '\n').repeat(Math.floor(9_990 / (line.length + 1)));
      const t0 = Date.now() - 3_600_000;
      for (let i = 0; i < 100; i++) await r2.put(`lake/2026-10-11/${ulid(t0 + i)}.ndjson`, body.padEnd(9_990, ' '));
      const req = getRequest('/api/lake/export', token);
      return async () => {
        const res = await app.fetch(req, env, ctx);
        if (res.headers.get('x-objects') !== '100') throw new Error(`lake export returned ${res.headers.get('x-objects')} objects`);
        await expectStatus(res, 200, 'lake export');
      };
    },
  },
  'POST /api/admin/prune (5 runs)': {
    async prepare() {
      const runIds = Array.from({ length: 5 }, (_, i) => `run_01CPUPRUNE${i}000000000000000000`);
      const { env, operatorToken, r2 } = await workerEnv({
        rows: (sql) => (sql.includes('FROM runs r') ? runIds.map((run_id) => ({ run_id })) : []),
      });
      // About 135 raw OpenLineage objects per seed-101 run.
      for (const id of runIds) for (let i = 0; i < 135; i++) await r2.put(`lineage/${id}/${String(i).padStart(32, '0')}.json`, '{}');
      const req = request('/api/admin/prune', operatorToken, { olderThanDays: 30, maxRuns: 5 });
      return async () => expectStatus(await app.fetch(req, env, ctx), 200, 'prune');
    },
  },
  'investigate consumer (5 messages)': {
    async prepare() {
      const { env } = await workerEnv();
      const b = batch('datatrust-investigate', Array.from({ length: 5 }, (_, i) => ({ runId: `${RUN_ID}${i}`, incidentId: `inc_${i}`, trigger: 'checks' })));
      return () => queue(b, env);
    },
  },
  'DLQ consumer (10 messages)': {
    async prepare() {
      const { env } = await workerEnv();
      const b = batch('datatrust-dlq', Array.from({ length: 10 }, (_, i) => ({ runId: `${RUN_ID}${i}`, checkResults: s01.checks })));
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
