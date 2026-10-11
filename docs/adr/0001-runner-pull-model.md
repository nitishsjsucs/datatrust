# ADR-0001: Runner pull model

- Status: accepted, 2026-10-10

## Context

A Cloudflare Worker cannot run dbt, cannot reach a DuckDB file on a laptop, and should never hold warehouse credentials. Validation still has to be coordinated from Cloudflare (Queues and Workflows).

## Decision

A Python runner leases jobs from the Worker over HTTPS (outbound only) and posts results back. The Worker never sends free-form SQL: a diagnostics job carries probe invocations (probe kind, node id, columns, parameters). The runner renders SQL from its own templates, with identifiers taken from its own `relations.json` and validated against the warehouse information schema. The protocol is the same locally (`wrangler dev`) and in production; no extra listening port is opened anywhere.

## Consequences

- Warehouse credentials stay on the runner (Nitish's ADC in production, a DuckDB file locally).
- A compromised Worker can at worst ask for probes the runner already knows how to render.
- Runs wait for a runner; there is no cron trigger in v1 (review finding I6).
