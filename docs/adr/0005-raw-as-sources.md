# ADR-0005: Raw data are dbt sources, not seeds

- Status: accepted, 2026-10-10

## Context

Column-level lineage comes from `dbt-ol` (openlineage-dbt 1.53.0). Verified during the spec review: `dbt-ol` leaves `ref()`-ed seeds out of dataset-level `inputs` (they still appear in `columnLineage`), while sources appear in both.

## Decision

The 13 raw tables are loaded by the runner into `raw.*` (DuckDB) or `datatrust_raw.*` (BigQuery) and declared in `dbt/models/sources.yml`. Sources carry the same probe meta as models (grain, keys, foreign keys, intervals, time-zone join path, FX columns, casts).

## Consequences

The lineage graph is complete from raw tables to metrics, and 13 of the 20 benchmark ground truths are source nodes the trace can reach.
