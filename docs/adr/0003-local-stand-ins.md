# ADR-0003: Local stand-ins are labelled, never presented as the production service

- Status: accepted, 2026-10-10

## Context

Most of DataTrust runs offline and in CI with stand-ins: DuckDB for BigQuery, Miniflare for Workers, Queues, Workflows, D1 and R2, a local OpenAI-compatible LLM or a template for Workers AI, a pyiceberg SQL catalog for Basin Catalog, and locally generated RS256 keys for Cloudflare Access.

## Decision

The README's "What runs where" table (SPEC section 4) is normative, and its status table uses the labels of SPEC section 4.1. A label moves to "executed in production" only with a dated command (`npm run prod:smoke`). Every persisted incident records `provenance`: warehouse, summarizer provider and model, and lake sink. Benchmark reports name the warehouse ("DuckDB 1.5.6 via dbt-duckdb 1.11.0, local stand-in for BigQuery").

## Consequences

Resume wording about Cloudflare and Workers AI depends on the production smoke run (SPEC section 22), not on local results.
