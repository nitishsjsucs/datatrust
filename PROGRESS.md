# Build progress

Tracks the SPEC.md section 23 commit plan. Updated with every commit.

## Position

Commit 4 of 19 (core) done: `feat(dbt): sources, staging with enforced contracts, DuckDB profile`.

## Done

- 1. SPEC.md, README skeleton (status all "planned"), LICENSE (MIT), .gitignore, this file.
- 2. npm workspaces (`packages/rca`, `apps/worker`), package-lock.json (includes Linux workerd and esbuild binaries), tsconfig.base.json, pyproject.toml + uv.lock (136 packages, dbt-core 1.12.5 / dbt-duckdb 1.11.0 / dbt-bigquery 1.12.1), CI with `node` and `python` jobs, .env.example, Makefile.
- 3. `pipelines/datatrust/synth/` (spec, rng, wordlists, generator), `datatrust synth` CLI, counts test (6 seeds), golden hash test for seed 101.
- 4. dbt project (`dbt/`), DuckDB profile with `TimeZone: UTC`, 13 sources with model meta, 13 staging views with enforced contracts, `dt_type`/`dt_cast`/`tz_local_date`/`tz_local_hour` dispatch macros, `generate_schema_name`, DuckDB loader, `datatrust load|build` CLI, `test_session_timezone.py`, `test_warehouse_types.py`. Raw `stage_events.stage` now carries ATS labels (for example "Phone Screen") mapped to canonical stages in `stg_stage_events`; seed 101 golden hash for `stage_events` re-recorded.

## Next

- 5. `feat(dbt): intermediate, marts, metrics and restricted view with BigQuery dialect macros`.

## Check status (at this commit, 2026-10-10, macOS)

- `npm run typecheck`: pass
- `npm run test:rca`: 1 passed
- `npm run test:worker`: no tests yet (`--passWithNoTests`, removed when the Worker lands in commit 11)
- `uv run ruff check`: pass
- `uv run pytest`: 25 passed

## Deviations from SPEC.md

- `apps/web` (stretch) is not in the npm workspaces list until it exists.
- Contract `data_type` cannot call project macros: dbt 1.12.5 renders schema YAML without them ("'dt_type' is undefined", observed 2026-10-10). Contracts use inline `{{ 'int64' if target.type == 'bigquery' else 'bigint' }}` expressions instead; `test_warehouse_types.py::test_contract_types_mirror_dt_type` asserts every such expression equals the `dt_type` mapping, so `macros/dialect/types.sql` stays the single source of truth.
- Raw stage values are ATS labels rather than canonical codes, so the staging "stage code mapping" that scenario T19 corrupts is a real mapping.
