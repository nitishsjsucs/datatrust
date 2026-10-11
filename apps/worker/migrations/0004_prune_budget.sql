-- Daily prune ledger (SPEC risk 25, 2026-10-11 review). One row per UTC day (D1's allowances reset at 00:00
-- UTC). Prune deletes count as D1 rows written; POST /api/admin/prune records each call's measured count
-- (meta.rows_written) here and stops pruning for the day once PRUNE_DAILY_ROWS would be passed, so pruning
-- can never use more than a fifth of DataTrust's daily D1 write share.
CREATE TABLE prune_budget (
  day TEXT PRIMARY KEY,
  rows_written INTEGER NOT NULL,
  runs INTEGER NOT NULL
);
