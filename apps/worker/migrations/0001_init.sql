-- DataTrust metadata store (SPEC 13.2). Same migrations locally (Miniflare D1) and in production (D1 datatrust).

CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  workflow_instance_id TEXT,
  target TEXT NOT NULL,
  seed INTEGER,
  scenario TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  n_pass INTEGER,
  n_fail INTEGER,
  n_error INTEGER,
  n_skip INTEGER,
  incident_id TEXT
);

CREATE TABLE jobs (
  job_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  lease_token TEXT,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  workflow_instance_id TEXT,
  event_type TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX jobs_by_status ON jobs (status, kind, created_at);
CREATE INDEX jobs_by_run ON jobs (run_id);

CREATE TABLE check_results (
  run_id TEXT NOT NULL,
  check_id TEXT NOT NULL,
  test_name TEXT NOT NULL,
  category TEXT NOT NULL,
  status TEXT NOT NULL,
  failures INTEGER NOT NULL,
  node TEXT NOT NULL,
  columns_json TEXT NOT NULL,
  message TEXT,
  PRIMARY KEY (run_id, check_id)
);

CREATE TABLE lineage_events (
  run_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  processed_at TEXT,
  PRIMARY KEY (run_id, event_id)
);

CREATE TABLE lineage_nodes (
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  relation TEXT NOT NULL,
  checksum TEXT,
  columns_json TEXT NOT NULL,
  meta_json TEXT NOT NULL,
  PRIMARY KEY (run_id, node_id)
);

-- '*' as the column marks a dataset-level edge.
CREATE TABLE lineage_edges (
  run_id TEXT NOT NULL,
  src_node TEXT NOT NULL,
  src_column TEXT NOT NULL,
  dst_node TEXT NOT NULL,
  dst_column TEXT NOT NULL,
  PRIMARY KEY (run_id, src_node, src_column, dst_node, dst_column)
);

CREATE TABLE incidents (
  incident_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  failing_checks_json TEXT NOT NULL,
  ranked_json TEXT NOT NULL,
  evidence_r2_key TEXT,
  summary_draft_json TEXT,
  summary_json TEXT,
  summary_provider TEXT,
  summary_model TEXT,
  summary_attempts INTEGER,
  summary_fallback INTEGER,
  summary_fallback_reason TEXT,
  provenance_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX incidents_by_run ON incidents (run_id);

CREATE TABLE dead_letters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  queue TEXT NOT NULL,
  body_json TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL
);
