-- One BigQuery run at a time (SPEC 13.1): POST /api/runs refuses a BigQuery run while another is in flight,
-- found through this index (target, status, created_at) instead of a scan of every stored run.
CREATE INDEX runs_by_target_status ON runs (target, status, created_at);
