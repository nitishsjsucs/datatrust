# ADR-0002: One RCA implementation, in TypeScript

- Status: accepted, 2026-10-10

## Context

Root-cause logic runs inside Workflow steps (TypeScript) and in the offline benchmark (driven from Python). Two implementations would drift, and benchmark numbers would not describe the deployed code.

## Decision

Lineage graph building, upstream tracing, probe planning, ranking, sanitization and summary validation live in `packages/rca` as pure functions with no I/O. The Worker imports them; the Python runner and benchmark call the same code through the esbuild bundle `packages/rca/dist/cli.mjs` (`rca graph|trace|plan|rank|sanitize|check-sanitized|tune|evaluate|loso|coverage`), JSON in and JSON out.

## Consequences

- The Python side needs Node 22+ and `npm run build -w @datatrust/rca`; CI builds the bundle before `pytest`.
- An end-to-end parity test (SPEC 12.2, commit 15) checks that the Worker path and the offline path rank identically for seed 101.
