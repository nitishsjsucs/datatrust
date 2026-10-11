# ADR-0006: Deterministic warehouse semantics

- Status: accepted, 2026-10-10

## Context

Review findings B1 and B2: without explicit rules the same seed gives different answers on the Mac, on ubuntu-latest and on BigQuery. A dbt-duckdb session inherits the machine time zone, and DuckDB's plain `numeric` is DECIMAL(18,3), which rounds an INR rate of about 0.0117 to 0.012. Decimal division in DuckDB yields DOUBLE and multiplication widens the scale, which breaks enforced contracts.

## Decision

- Every DuckDB session runs in UTC (`settings: {TimeZone: UTC}` in the dbt profile; the loader and the probe connection set it too).
- Every stored instant is a time-zone-aware UTC timestamp (pyarrow `timestamp('us', tz='UTC')`, DuckDB TIMESTAMPTZ, BigQuery TIMESTAMP). Local dates and hours come only from the `tz_local_date` and `tz_local_hour` dialect macros.
- Money and rates are `decimal(38,9)` on DuckDB and `NUMERIC` on BigQuery through `dt_type`/`dt_cast`, and every money or rate output expression is wrapped in `dt_cast`.
- The generator uses integer minor units and FX micro-units, `random.Random.random()` only, and the pinned `tzdata` package through `zoneinfo.reset_tzpath([])`.

## Consequences

`test_session_timezone.py`, `test_warehouse_types.py` and the seed-101 golden hashes enforce these rules, and CI runs the clean baseline under `TZ=UTC` and `TZ=America/Los_Angeles`.
