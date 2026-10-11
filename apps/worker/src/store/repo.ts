/** D1 repositories (SPEC 13.2). All SQL lives here. */
import type { CheckResult, LineageGraph, RankedCandidate } from '@datatrust/rca';
import { randomToken, ulid } from '../ids';

export type RunStatus = 'queued' | 'running' | 'passed' | 'failed' | 'stale' | 'error';
export type JobKind = 'dbt_build' | 'diagnostics';
export type JobStatus = 'queued' | 'leased' | 'completed' | 'failed';

export interface RunRow {
  run_id: string;
  workflow_instance_id: string | null;
  target: string;
  seed: number | null;
  scenario: string | null;
  status: RunStatus;
  created_at: string;
  finished_at: string | null;
  n_pass: number | null;
  n_fail: number | null;
  n_error: number | null;
  n_skip: number | null;
  incident_id: string | null;
}

export interface JobRow {
  job_id: string;
  run_id: string;
  kind: JobKind;
  payload_json: string;
  status: JobStatus;
  lease_token: string | null;
  lease_owner: string | null;
  lease_expires_at: number | null;
  attempts: number;
  workflow_instance_id: string | null;
  event_type: string | null;
  created_at: string;
  updated_at: string;
}

export const LEASE_TTL_MS = 15 * 60 * 1000;
export const MAX_ATTEMPTS = 3;
/**
 * How long each kind's workflow waits for the job's event (ValidationRunWorkflow wait-build, 6 hours;
 * InvestigationWorkflow wait-diagnostics, 1 hour). A job older than its wait can never be delivered: the
 * workflow has moved on, so the job is never leased again and the lease sweep fails it.
 */
export const JOB_WAIT_MS: Record<JobKind, number> = { dbt_build: 6 * 60 * 60 * 1000, diagnostics: 60 * 60 * 1000 };

const nowIso = () => new Date().toISOString();

// ------------------------------------------------------------------------------------------- runs

export async function insertRun(
  db: D1Database,
  r: { runId: string; target: string; seed: number | null; scenario: string | null },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO runs (run_id, target, seed, scenario, status, created_at) VALUES (?, ?, ?, ?, 'queued', ?)`,
    )
    .bind(r.runId, r.target, r.seed, r.scenario, nowIso())
    .run();
}

/**
 * How long a BigQuery run counts as in flight (SPEC 13.1): queued or running for at most the build wait plus
 * the ingest retries (so a run whose workflow died blocks for 8 hours at most), and failed without its
 * incident for at most the diagnostics wait plus margin. Open BigQuery diagnostics jobs (also from alerts)
 * count too.
 */
export const BIGQUERY_RUN_IN_FLIGHT_MS = 8 * 60 * 60 * 1000;
export const BIGQUERY_INVESTIGATION_IN_FLIGHT_MS = 2 * 60 * 60 * 1000;

const BIGQUERY_BUSY = `EXISTS (SELECT 1 FROM runs WHERE target = 'bigquery' AND (
    (status IN ('queued', 'running') AND created_at > ?5)
    OR (status = 'failed' AND incident_id IS NULL AND finished_at > ?6)))
  OR EXISTS (SELECT 1 FROM jobs WHERE status IN ('queued', 'leased') AND kind = 'diagnostics'
    AND json_extract(payload_json, '$.target') = 'bigquery' AND created_at > ?6)`;

/**
 * Insert a BigQuery run only while no other BigQuery run is in flight, in ONE statement (so two concurrent
 * requests cannot both pass): every BigQuery run loads and builds the same `datatrust_*` datasets, so a
 * second build would change the tables the first run's diagnostics probe. Returns false when refused.
 */
export async function insertBigQueryRunIfIdle(
  db: D1Database,
  r: { runId: string; seed: number | null; scenario: string | null },
  now = Date.now(),
): Promise<boolean> {
  const res = await db
    .prepare(
      `INSERT INTO runs (run_id, target, seed, scenario, status, created_at)
       SELECT ?1, 'bigquery', ?2, ?3, 'queued', ?4 WHERE NOT (${BIGQUERY_BUSY})`,
    )
    .bind(
      r.runId,
      r.seed,
      r.scenario,
      new Date(now).toISOString(),
      new Date(now - BIGQUERY_RUN_IN_FLIGHT_MS).toISOString(),
      new Date(now - BIGQUERY_INVESTIGATION_IN_FLIGHT_MS).toISOString(),
    )
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** The BigQuery run (or the run of an open BigQuery diagnostics job) that blocks a new one, for the 409. */
export async function bigQueryRunInFlight(db: D1Database, now = Date.now()): Promise<{ run_id: string; status: string } | null> {
  return db
    .prepare(
      `SELECT run_id, status FROM runs WHERE target = 'bigquery' AND (
         (status IN ('queued', 'running') AND created_at > ?1)
         OR (status = 'failed' AND incident_id IS NULL AND finished_at > ?2))
       UNION ALL
       SELECT run_id, 'investigating' AS status FROM jobs WHERE status IN ('queued', 'leased') AND kind = 'diagnostics'
         AND json_extract(payload_json, '$.target') = 'bigquery' AND created_at > ?2
       LIMIT 1`,
    )
    .bind(new Date(now - BIGQUERY_RUN_IN_FLIGHT_MS).toISOString(), new Date(now - BIGQUERY_INVESTIGATION_IN_FLIGHT_MS).toISOString())
    .first<{ run_id: string; status: string }>();
}

export async function getRun(db: D1Database, runId: string): Promise<RunRow | null> {
  return db.prepare(`SELECT * FROM runs WHERE run_id = ?`).bind(runId).first<RunRow>();
}

export async function markRunRunning(db: D1Database, runId: string, instanceId: string): Promise<void> {
  await db
    .prepare(`UPDATE runs SET status = 'running', workflow_instance_id = ? WHERE run_id = ? AND status IN ('queued', 'running')`)
    .bind(instanceId, runId)
    .run();
}

export async function finishRun(
  db: D1Database,
  runId: string,
  status: RunStatus,
  counts?: { pass: number; fail: number; error: number; skip: number },
): Promise<void> {
  await db
    .prepare(
      `UPDATE runs SET status = ?, finished_at = ?, n_pass = coalesce(?, n_pass), n_fail = coalesce(?, n_fail),
       n_error = coalesce(?, n_error), n_skip = coalesce(?, n_skip) WHERE run_id = ?`,
    )
    .bind(status, nowIso(), counts?.pass ?? null, counts?.fail ?? null, counts?.error ?? null, counts?.skip ?? null, runId)
    .run();
}

export async function setRunIncident(db: D1Database, runId: string, incidentId: string): Promise<void> {
  await db.prepare(`UPDATE runs SET incident_id = ? WHERE run_id = ?`).bind(incidentId, runId).run();
}

// ------------------------------------------------------------------------------------------- jobs

export async function insertJob(
  db: D1Database,
  j: { runId: string; kind: JobKind; payload: unknown; workflowInstanceId: string; eventType: string; jobId?: string },
): Promise<string> {
  const jobId = j.jobId ?? `job_${ulid()}`;
  const ts = nowIso();
  await db
    .prepare(
      `INSERT INTO jobs (job_id, run_id, kind, payload_json, status, attempts, workflow_instance_id, event_type,
       created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?) ON CONFLICT (job_id) DO NOTHING`,
    )
    .bind(jobId, j.runId, j.kind, JSON.stringify(j.payload), j.workflowInstanceId, j.eventType, ts, ts)
    .run();
  return jobId;
}

/** ISO cutoffs: jobs created before these are past their workflow's wait (JOB_WAIT_MS). */
function waitCutoffs(now: number): [build: string, diagnostics: string] {
  return [new Date(now - JOB_WAIT_MS.dbt_build).toISOString(), new Date(now - JOB_WAIT_MS.diagnostics).toISOString()];
}

/**
 * Lease the oldest eligible job in one statement (UPDATE ... RETURNING, SPEC 13.2). A job older than its
 * workflow's wait is never leased: nothing would receive its result.
 */
export async function leaseJob(
  db: D1Database,
  kinds: JobKind[],
  owner: string,
  target: string,
  now = Date.now(),
): Promise<JobRow | null> {
  if (kinds.length === 0) return null;
  const token = randomToken();
  const placeholders = kinds.map(() => '?').join(', ');
  const [buildCutoff, diagCutoff] = waitCutoffs(now);
  return db
    .prepare(
      `UPDATE jobs SET status = 'leased', lease_token = ?, lease_owner = ?, lease_expires_at = ?,
         attempts = attempts + 1, updated_at = ?
       WHERE job_id = (
         SELECT job_id FROM jobs
         WHERE kind IN (${placeholders}) AND attempts < ${MAX_ATTEMPTS}
           AND json_extract(payload_json, '$.target') = ?
           AND (status = 'queued' OR (status = 'leased' AND lease_expires_at < ?))
           AND created_at > CASE kind WHEN 'dbt_build' THEN ? ELSE ? END
         ORDER BY created_at, rowid LIMIT 1
       )
       RETURNING *`,
    )
    .bind(token, owner, now + LEASE_TTL_MS, nowIso(), ...kinds, target, now, buildCutoff, diagCutoff)
    .first<JobRow>();
}

/**
 * The lease sweep (SPEC 13.2), one statement: fail jobs whose last lease expired after the final attempt, and
 * open jobs past their workflow's wait (JOB_WAIT_MS), and return them. Their lease token is cleared, so a
 * runner still holding one is refused from then on.
 */
export async function sweepExhaustedJobs(db: D1Database, now = Date.now()): Promise<JobRow[]> {
  const [buildCutoff, diagCutoff] = waitCutoffs(now);
  const { results } = await db
    .prepare(
      `UPDATE jobs SET status = 'failed', lease_token = NULL, updated_at = ?
       WHERE (status = 'leased' AND attempts >= ${MAX_ATTEMPTS} AND lease_expires_at < ?)
          OR (status IN ('queued', 'leased') AND created_at <= CASE kind WHEN 'dbt_build' THEN ? ELSE ? END)
       RETURNING *`,
    )
    .bind(nowIso(), now, buildCutoff, diagCutoff)
    .all<JobRow>();
  return results;
}

/**
 * Fail the open (queued or leased) jobs a workflow instance created, in one statement: called when the run
 * goes stale or errors, and when an investigation stops waiting for its diagnostics, so no runner leases a
 * job whose result nothing would receive. Returns how many jobs it failed.
 */
export async function failOpenJobs(db: D1Database, runId: string, workflowInstanceId: string): Promise<number> {
  const res = await db
    .prepare(
      `UPDATE jobs SET status = 'failed', lease_token = NULL, updated_at = ?
       WHERE run_id = ? AND workflow_instance_id = ? AND status IN ('queued', 'leased')`,
    )
    .bind(nowIso(), runId, workflowInstanceId)
    .run();
  return res.meta.changes ?? 0;
}

export async function getJob(db: D1Database, jobId: string): Promise<JobRow | null> {
  return db.prepare(`SELECT * FROM jobs WHERE job_id = ?`).bind(jobId).first<JobRow>();
}

export async function completeJob(db: D1Database, jobId: string, token: string, status: 'completed' | 'failed'): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE jobs SET status = ?, updated_at = ? WHERE job_id = ? AND status = 'leased' AND lease_token = ?`,
    )
    .bind(status, nowIso(), jobId, token)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/**
 * Where a job stands for the holder of `token`: 'active' while the job is leased under that token, also past
 * `lease_expires_at` as long as nobody re-leased it (a re-lease rotates the token, and the sweep clears it, so
 * a stale holder is still refused); 'done' once that holder completed it, so a retried completion can be
 * answered again; null otherwise.
 */
export function leaseState(job: JobRow | null, token: string | null): 'active' | 'done' | null {
  if (!job || !token || job.lease_token !== token) return null;
  if (job.status === 'leased') return 'active';
  if (job.status === 'completed' || job.status === 'failed') return 'done';
  return null;
}

export function isLeaseValid(job: JobRow | null, token: string | null): job is JobRow {
  return leaseState(job, token) === 'active';
}

// ------------------------------------------------------------------------------------------- checks

/** One set-based upsert for any number of check results (SPEC 28.5.3): one statement per call. */
export function checkResultsStatement(db: D1Database, runId: string, checks: CheckResult[]): D1PreparedStatement {
  const rows = checks.map((c) => ({
    checkId: c.checkId,
    testName: c.testName,
    category: c.category,
    status: c.status,
    failures: c.failures,
    node: c.node,
    columnsJson: JSON.stringify({ columns: c.columns, also: c.also ?? [], kind: c.kind }),
    message: c.message ?? null,
  }));
  return db
    .prepare(
      `INSERT INTO check_results (run_id, check_id, test_name, category, status, failures, node, columns_json, message)
       SELECT ?1, json_extract(value, '$.checkId'), json_extract(value, '$.testName'), json_extract(value, '$.category'),
         json_extract(value, '$.status'), json_extract(value, '$.failures'), json_extract(value, '$.node'),
         json_extract(value, '$.columnsJson'), json_extract(value, '$.message')
       FROM json_each(?2) WHERE true
       ON CONFLICT (run_id, check_id) DO UPDATE SET status = excluded.status, failures = excluded.failures,
         message = excluded.message, columns_json = excluded.columns_json`,
    )
    .bind(runId, JSON.stringify(rows));
}

export async function upsertCheckResults(db: D1Database, runId: string, checks: CheckResult[]): Promise<void> {
  if (checks.length === 0) return;
  await checkResultsStatement(db, runId, checks).run();
}

interface CheckRow {
  check_id: string;
  test_name: string;
  category: string;
  status: CheckResult['status'];
  failures: number;
  node: string;
  columns_json: string;
  message: string | null;
}

export async function listCheckResults(db: D1Database, runId: string): Promise<CheckResult[]> {
  const { results } = await db
    .prepare(`SELECT * FROM check_results WHERE run_id = ? ORDER BY check_id`)
    .bind(runId)
    .all<CheckRow>();
  return results.map((r) => {
    const extra = JSON.parse(r.columns_json) as { columns: string[]; also: CheckResult['also']; kind: CheckResult['kind'] };
    return {
      checkId: r.check_id,
      testName: r.test_name,
      category: r.category,
      kind: extra.kind ?? 'data_test',
      status: r.status,
      failures: r.failures,
      node: r.node,
      columns: extra.columns ?? [],
      also: extra.also ?? [],
      message: r.message,
    };
  });
}

export async function countCheckResults(db: D1Database, runId: string): Promise<number> {
  const row = await db.prepare(`SELECT count(*) AS n FROM check_results WHERE run_id = ?`).bind(runId).first<{ n: number }>();
  return row?.n ?? 0;
}

// ------------------------------------------------------------------------------------------- lineage

export type EdgeRow = [srcNode: string, srcColumn: string, dstNode: string, dstColumn: string];

/**
 * Set-based writes for one lineage bundle (SPEC 28.5.2, 28.5.3): one statement for all edges and one for the
 * lineage_events rows (inserted already processed), each over a JSON array parameter through json_each, so
 * the consumer issues two statements whatever the number of edges. Run them in one db.batch (atomic).
 */
export function lineageBundleStatements(
  db: D1Database,
  runId: string,
  edges: EdgeRow[],
  events: Array<{ eventId: string; r2Key: string }>,
): D1PreparedStatement[] {
  return [
    lineageEdgesStatement(db, runId, edges),
    db
      .prepare(
        `INSERT INTO lineage_events (run_id, event_id, r2_key, processed_at)
         SELECT ?1, json_extract(value, '$[0]'), json_extract(value, '$[1]'), ?3
         FROM json_each(?2) WHERE true ON CONFLICT DO NOTHING`,
      )
      .bind(runId, JSON.stringify(events.map((e) => [e.eventId, e.r2Key])), nowIso()),
  ];
}

/** lineage_events rows of a run; every row is written already processed by the bundle consumer. */
export async function countLineageEvents(db: D1Database, runId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT count(*) AS n FROM lineage_events WHERE run_id = ?`)
    .bind(runId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Nodes (and any edges) of a lineage graph with set-based statements (SPEC 28.5.3): one node upsert and, when
 * the graph has edges, one edge insert. The relations upload writes 42 nodes with a single statement.
 */
export async function upsertLineageGraph(db: D1Database, runId: string, g: LineageGraph, meta: Record<string, unknown> = {}): Promise<void> {
  const nodes = Object.entries(g.nodes).map(([id, n]) => [
    id,
    n.kind,
    n.relation,
    n.checksum,
    JSON.stringify({ columns: n.columns, classification: n.classification }),
    JSON.stringify(meta[id] ?? {}),
  ]);
  const edges: EdgeRow[] = [
    ...g.columnEdges.map((e): EdgeRow => [e.from.node, e.from.column ?? '*', e.to.node, e.to.column ?? '*']),
    ...g.datasetEdges.map((e): EdgeRow => [e.from, '*', e.to, '*']),
  ];
  const stmts: D1PreparedStatement[] = [];
  if (nodes.length) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO lineage_nodes (run_id, node_id, kind, relation, checksum, columns_json, meta_json)
           SELECT ?1, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'),
             json_extract(value, '$[3]'), json_extract(value, '$[4]'), json_extract(value, '$[5]')
           FROM json_each(?2) WHERE true
           ON CONFLICT (run_id, node_id) DO UPDATE SET kind = excluded.kind, relation = excluded.relation,
             checksum = excluded.checksum, columns_json = excluded.columns_json, meta_json = excluded.meta_json`,
        )
        .bind(runId, JSON.stringify(nodes)),
    );
  }
  if (edges.length) stmts.push(lineageEdgesStatement(db, runId, edges));
  if (stmts.length === 1) await stmts[0]!.run();
  else if (stmts.length > 1) await db.batch(stmts);
}

function lineageEdgesStatement(db: D1Database, runId: string, edges: EdgeRow[]): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO lineage_edges (run_id, src_node, src_column, dst_node, dst_column)
       SELECT ?1, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]')
       FROM json_each(?2) WHERE true ON CONFLICT DO NOTHING`,
    )
    .bind(runId, JSON.stringify(edges));
}

/** The run's lineage graph in ONE statement: nodes (ordered by id), then edges (ordered as before). */
export async function loadLineageGraph(db: D1Database, runId: string): Promise<LineageGraph> {
  const { results } = await db
    .prepare(
      `SELECT * FROM (
         SELECT 'n' AS t, node_id AS a, kind AS b, relation AS c, checksum AS d, columns_json AS e FROM lineage_nodes WHERE run_id = ?1
         UNION ALL
         SELECT 'x' AS t, src_node AS a, src_column AS b, dst_node AS c, dst_column AS d, NULL AS e FROM lineage_edges WHERE run_id = ?1
       ) ORDER BY t, CASE WHEN t = 'n' THEN a END, c, d, a, b`,
    )
    .bind(runId)
    .all<{ t: 'n' | 'x'; a: string; b: string; c: string; d: string | null; e: string | null }>();
  const g: LineageGraph = { nodes: {}, columnEdges: [], datasetEdges: [] };
  for (const r of results) {
    if (r.t === 'n') {
      const c = JSON.parse(r.e ?? '{}') as { columns: string[]; classification: LineageGraph['nodes'][string]['classification'] };
      g.nodes[r.a] = { kind: r.b as 'source' | 'model', relation: r.c, checksum: r.d, columns: c.columns, classification: c.classification };
    } else if (r.b === '*' && r.d === '*') g.datasetEdges.push({ from: r.a, to: r.c });
    else g.columnEdges.push({ from: { node: r.a, column: r.b }, to: { node: r.c, column: r.d ?? '*' } });
  }
  return g;
}

export async function loadNodeMeta(db: D1Database, runId: string): Promise<Record<string, unknown>> {
  const { results } = await db
    .prepare(`SELECT node_id, meta_json FROM lineage_nodes WHERE run_id = ?`)
    .bind(runId)
    .all<{ node_id: string; meta_json: string }>();
  return Object.fromEntries(results.map((r) => [r.node_id, JSON.parse(r.meta_json)]));
}

/** Model checksums of the most recent passed run before this one, for the change signal (one statement). */
export async function baselineChecksums(db: D1Database, runId: string): Promise<Record<string, string | null> | null> {
  const { results } = await db
    .prepare(
      `SELECT node_id, checksum FROM lineage_nodes WHERE kind = 'model' AND run_id = (
         SELECT run_id FROM runs WHERE status = 'passed' AND run_id <> ?1
           AND created_at <= (SELECT created_at FROM runs WHERE run_id = ?1)
         ORDER BY created_at DESC LIMIT 1)`,
    )
    .bind(runId)
    .all<{ node_id: string; checksum: string | null }>();
  return results.length ? Object.fromEntries(results.map((r) => [r.node_id, r.checksum])) : null;
}

/** The last passed run of the same target created before this one (time-travel evidence, SPEC 10). */
export async function lastGreenRun(db: D1Database, runId: string): Promise<{ runId: string; finishedAtMs: number } | null> {
  const prev = await db
    .prepare(
      `SELECT r.run_id, r.finished_at FROM runs r JOIN runs cur ON cur.run_id = ?
       WHERE r.status = 'passed' AND r.run_id <> cur.run_id AND r.target = cur.target AND r.finished_at IS NOT NULL
         AND r.created_at <= cur.created_at
       ORDER BY r.created_at DESC LIMIT 1`,
    )
    .bind(runId)
    .first<{ run_id: string; finished_at: string }>();
  if (!prev) return null;
  const ms = Date.parse(prev.finished_at);
  return Number.isFinite(ms) ? { runId: prev.run_id, finishedAtMs: ms } : null;
}

// ------------------------------------------------------------------------------------------- incidents

export interface IncidentInsert {
  incidentId: string;
  runId: string;
  trigger: string;
  status: string;
  failingChecks: unknown;
  ranked: RankedCandidate[];
  evidenceR2Key: string | null;
  summaryDraft: unknown;
  summary: unknown;
  summaryProvider: string | null;
  summaryModel: string | null;
  summaryAttempts: number;
  summaryFallback: boolean;
  summaryFallbackReason: string | null;
  provenance: unknown;
}

export async function upsertIncident(db: D1Database, i: IncidentInsert): Promise<void> {
  await db
    .prepare(
      `INSERT INTO incidents (incident_id, run_id, trigger, status, failing_checks_json, ranked_json, evidence_r2_key,
         summary_draft_json, summary_json, summary_provider, summary_model, summary_attempts, summary_fallback,
         summary_fallback_reason, provenance_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (incident_id) DO UPDATE SET status = excluded.status, ranked_json = excluded.ranked_json,
         evidence_r2_key = excluded.evidence_r2_key, summary_draft_json = excluded.summary_draft_json,
         summary_json = excluded.summary_json, summary_provider = excluded.summary_provider,
         summary_model = excluded.summary_model, summary_attempts = excluded.summary_attempts,
         summary_fallback = excluded.summary_fallback, summary_fallback_reason = excluded.summary_fallback_reason,
         provenance_json = excluded.provenance_json`,
    )
    .bind(
      i.incidentId,
      i.runId,
      i.trigger,
      i.status,
      JSON.stringify(i.failingChecks),
      JSON.stringify(i.ranked),
      i.evidenceR2Key,
      i.summaryDraft === undefined ? null : JSON.stringify(i.summaryDraft),
      i.summary === undefined ? null : JSON.stringify(i.summary),
      i.summaryProvider,
      i.summaryModel,
      i.summaryAttempts,
      i.summaryFallback ? 1 : 0,
      i.summaryFallbackReason,
      JSON.stringify(i.provenance),
      nowIso(),
    )
    .run();
}

export interface IncidentRow {
  incident_id: string;
  run_id: string;
  trigger: string;
  status: string;
  failing_checks_json: string;
  ranked_json: string;
  evidence_r2_key: string | null;
  summary_draft_json: string | null;
  summary_json: string | null;
  summary_provider: string | null;
  summary_model: string | null;
  summary_attempts: number | null;
  summary_fallback: number | null;
  summary_fallback_reason: string | null;
  provenance_json: string;
  created_at: string;
}

/** One primary-key read: does this incident already exist? */
export async function incidentExists(db: D1Database, id: string): Promise<boolean> {
  return (await db.prepare(`SELECT 1 AS found FROM incidents WHERE incident_id = ?`).bind(id).first<{ found: number }>()) !== null;
}

export async function getIncident(db: D1Database, id: string): Promise<IncidentRow | null> {
  return db.prepare(`SELECT * FROM incidents WHERE incident_id = ?`).bind(id).first<IncidentRow>();
}

export async function listIncidents(db: D1Database, runId?: string | null): Promise<IncidentRow[]> {
  const q = runId
    ? db.prepare(`SELECT * FROM incidents WHERE run_id = ? ORDER BY created_at DESC LIMIT 100`).bind(runId)
    : db.prepare(`SELECT * FROM incidents ORDER BY created_at DESC LIMIT 100`);
  return (await q.all<IncidentRow>()).results;
}

// ------------------------------------------------------------------------------------------- dead letters

/** Every dead letter of a DLQ batch with one statement (SPEC 28.5.3). */
export async function insertDeadLetters(
  db: D1Database,
  queue: string,
  letters: Array<{ body: unknown; error: string | null }>,
): Promise<void> {
  if (!letters.length) return;
  await db
    .prepare(
      `INSERT INTO dead_letters (queue, body_json, error, created_at)
       SELECT ?1, json_extract(value, '$[0]'), json_extract(value, '$[1]'), ?3 FROM json_each(?2)`,
    )
    .bind(queue, JSON.stringify(letters.map((l) => [JSON.stringify(l.body ?? null), l.error])), nowIso())
    .run();
}

// ------------------------------------------------------------------------------------------- prune

/**
 * Runs whose lineage detail may be pruned (SPEC risk 25: about 3,000 runs fill the Free plan's 500 MB
 * database): finished before `cutoff`, still holding lineage rows, oldest first, and never the latest passed
 * run, whose model checksums are the baseline of the next investigation (`baselineChecksums`). One statement.
 */
export async function prunableRuns(db: D1Database, cutoffIso: string, limit: number): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT r.run_id FROM runs r
       WHERE r.created_at < ?1 AND r.status IN ('passed', 'failed', 'error', 'stale')
         AND r.run_id IS NOT (SELECT run_id FROM runs WHERE status = 'passed' ORDER BY created_at DESC LIMIT 1)
         AND EXISTS (SELECT 1 FROM lineage_nodes WHERE run_id = r.run_id
                     UNION ALL SELECT 1 FROM lineage_edges WHERE run_id = r.run_id
                     UNION ALL SELECT 1 FROM lineage_events WHERE run_id = r.run_id)
       ORDER BY r.created_at, r.run_id LIMIT ?2`,
    )
    .bind(cutoffIso, limit)
    .all<{ run_id: string }>();
  return results.map((r) => r.run_id);
}

/**
 * Deletes the lineage rows (edges, events, nodes) of the given runs: three set-based statements in one batch.
 * Runs, jobs, check results and incidents (with their ranked candidates, evidence and summary) stay. Each
 * deleted row and index entry counts as a row written on D1 (about 900 per seed-101 run).
 */
export async function pruneLineageRows(
  db: D1Database,
  runIds: string[],
): Promise<{ edges: number; events: number; nodes: number }> {
  if (!runIds.length) return { edges: 0, events: 0, nodes: 0 };
  const ids = JSON.stringify(runIds);
  const del = (table: string) => db.prepare(`DELETE FROM ${table} WHERE run_id IN (SELECT value FROM json_each(?1))`).bind(ids);
  const [edges, events, nodes] = await db.batch([del('lineage_edges'), del('lineage_events'), del('lineage_nodes')]);
  return { edges: edges?.meta.changes ?? 0, events: events?.meta.changes ?? 0, nodes: nodes?.meta.changes ?? 0 };
}
