# Build progress

Tracks the SPEC.md section 23 commit plan. Updated with every commit.

## Position

Commit 6 of 19 (core) done: `feat(checks): 40 dbt and SQL checks with category registry`.

## Done

- 1. SPEC.md, README skeleton (status all "planned"), LICENSE (MIT), .gitignore, this file.
- 2. npm workspaces (`packages/rca`, `apps/worker`), package-lock.json (includes Linux workerd and esbuild binaries), tsconfig.base.json, pyproject.toml + uv.lock (136 packages, dbt-core 1.12.5 / dbt-duckdb 1.11.0 / dbt-bigquery 1.12.1), CI with `node` and `python` jobs, .env.example, Makefile.
- 3. `pipelines/datatrust/synth/` (spec, rng, wordlists, generator), `datatrust synth` CLI, counts test (6 seeds), golden hash test for seed 101.
- 4. dbt project (`dbt/`), DuckDB profile with `TimeZone: UTC`, 13 sources with model meta, 13 staging views with enforced contracts, `dt_type`/`dt_cast`/`tz_local_date`/`tz_local_hour` dispatch macros, `generate_schema_name`, DuckDB loader, `datatrust load|build` CLI, `test_session_timezone.py`, `test_warehouse_types.py`. Raw `stage_events.stage` now carries ATS labels (for example "Phone Screen") mapped to canonical stages in `stg_stage_events`; seed 101 golden hash for `stage_events` re-recorded.
- 5. 16 models (6 intermediate tables, 5 marts and 4 metrics with enforced contracts, 1 restricted view over the untagged aggregate), dispatch macros `date_spine`, `safe_divide`, `int_div`, `trailing_median` (+ `trailing_median_finish`), `ordered_path`, `time_travel`, `days_between`, `month_start`, `print_dialect_macros` run-operation, `bigquery` and `bigquery_sa` profiles with defaults, policy-tag vars with placeholders, `test_dialect_macros.py` (banned constructs, sqlglot both dialects, portable model SQL), `test_bigquery_parse.py`. Seed 101 builds all 29 models: 1,980 / 1,200 compensation rows, 0 null USD.
- 6. 40 checks (18 generic incl. custom `unique_combination` and `expression_is_true`, 22 singular SQL), `checks/registry.yml`, `datatrust.checks.registry` and `datatrust.checks.results` (run_results to CheckResult, contract failures classified as `schema_contract` with columns), `add_days` dialect macro, recorded contract-failure fixture (`pipelines/tests/record_fixtures.py`), `test_check_registry.py`, `test_clean_baseline.py` (CI runs it again under `TZ=America/Los_Angeles`), `test_contract_failure_classified.py`, documented-columns test. Clean build (29 models, 40 checks pass) verified by hand on seeds 1, 2, 3, 7, 42, 101-105.

## Next

- 7. `feat(lineage): capture OpenLineage from dbt-ol and build a column-level graph`.

## Check status (at this commit, 2026-10-10, macOS)

- `npm run typecheck`: pass
- `npm run test:rca`: 1 passed
- `npm run test:worker`: no tests yet (`--passWithNoTests`, removed when the Worker lands in commit 11)
- `uv run ruff check`: pass
- `uv run pytest`: 45 passed

## Deviations from SPEC.md

- `apps/web` (stretch) is not in the npm workspaces list until it exists.
- Contract `data_type` cannot call project macros: dbt 1.12.5 renders schema YAML without them ("'dt_type' is undefined", observed 2026-10-10). Contracts use inline `{{ 'int64' if target.type == 'bigquery' else 'bigint' }}` expressions instead; `test_warehouse_types.py::test_contract_types_mirror_dt_type` asserts every such expression equals the `dt_type` mapping, so `macros/dialect/types.sql` stays the single source of truth.
- `trailing_median` is split into two macros, `trailing_median` (window step in a CTE) and `trailing_median_finish` (exact median from the BigQuery array; identity on DuckDB), because BigQuery cannot take a median over a window frame in one expression.
- Extra dialect macros `days_between` and `month_start` (date arithmetic argument order differs between DuckDB and BigQuery).
- Raw stage values are ATS labels rather than canonical codes, so the staging "stage code mapping" that scenario T19 corrupts is a real mapping.
