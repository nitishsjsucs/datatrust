# DataTrust

Lineage-aware data quality and root-cause analysis for workforce data (HR, recruiting, compensation, payroll).

DataTrust builds a synthetic workforce warehouse with dbt, guards it with schema contracts and 40 data checks, captures column-level lineage as OpenLineage events, and when checks or metrics fail it traces the failure upstream, runs read-only diagnostic SQL probes, ranks the likely root cause, and writes an incident summary from sanitized evidence. Validation and investigation are coordinated by Cloudflare Queues and Workflows; summaries come from Workers AI in production.

> **Status: in progress.** v1 is being built from scratch against [SPEC.md](SPEC.md). Nothing below is implemented yet unless the status table says so. This README is updated with every milestone and never claims more than the repo contains.

All data is synthetic. No real employee or candidate data is used anywhere; emails use the reserved `example.com` domain.

## Status

Every component carries exactly one label (SPEC section 4.1). A label changes only with a dated command.

| Component | Status |
|---|---|
| Synthetic data generator (exact, seeded counts) | planned |
| dbt models, 22 enforced contracts, 40 checks | planned |
| OpenLineage capture and column-level lineage graph | planned |
| Diagnostic probes, root-cause ranker, baselines | planned |
| Fault-injection benchmark (20 scenarios) | planned |
| Worker API, D1, R2, Queues, ValidationRunWorkflow, InvestigationWorkflow | planned |
| Access JWT verification | planned |
| Workers AI summaries, AI Gateway | planned |
| Basin Pipelines, Basin Catalog (Iceberg) | planned |
| BigQuery path, policy tags, masking, authorized view, time travel | planned |
| `setup:prod` and `doctor` | planned |

## Architecture

```mermaid
flowchart LR
  USER["Operator: browser or CLI"]
  ACC["Cloudflare Access (prod)<br/>local RS256 JWKS (dev)"]

  subgraph RUNNER["Runner: Python + uv (laptop or CI)"]
    GEN["Synthetic generator<br/>seeded, exact counts"]
    INJ["Fault injector<br/>20 scenarios + decoys"]
    LOAD["Loader"]
    DBT["dbt-ol build<br/>22 contracts + 40 checks"]
    PROBE["Diagnostic probes<br/>read-only identity"]
    SAN["rca sanitize (Node CLI)<br/>HMAC tokens, aggregates only"]
  end

  WH[("Warehouse<br/>local: DuckDB stand-in<br/>prod: BigQuery")]

  subgraph CF["Worker 'datatrust' (local: wrangler dev / Miniflare, prod: Workers)"]
    API["Hono API<br/>Access JWT verification"]
    QCR[["Queue dt-check-results"]]
    QLE[["Queue dt-lineage-events"]]
    QIN[["Queue dt-investigate"]]
    WFV{{"ValidationRunWorkflow"}}
    WFI{{"InvestigationWorkflow"}}
    RCA["rca core (TypeScript)<br/>trace, plan, rank, sanitize"]
    D1[("D1: runs, jobs, checks,<br/>lineage, incidents")]
    R2[("R2: datatrust-artifacts")]
    SUM["Summarizer"]
    SINK["EventSink"]
  end

  AIG["AI Gateway 'datatrust'<br/>to Workers AI (prod)"]
  LLM["llama-server :8160 Qwen3-1.7B<br/>or template stub (local)"]
  PIPE["Basin Pipelines stream (prod)"]
  CAT[("Basin Catalog Iceberg<br/>on R2 datatrust-lake (prod)")]
  ICE[("pyiceberg SQL catalog<br/>local Iceberg stand-in")]

  USER --> ACC --> API
  GEN --> INJ --> LOAD --> WH
  DBT --> WH
  PROBE --> WH
  PROBE --> SAN
  RUNNER -- "lease jobs, post sanitized results,<br/>post OpenLineage events" --> API
  API --> QCR --> D1
  API --> QLE --> D1
  API -- "create" --> WFV
  WFV -- "job dbt_build" --> D1
  WFV -- "one message per failing run" --> QIN --> WFI
  WFI --> RCA
  WFI -- "job diagnostics" --> D1
  WFI --> SUM
  SUM -- prod --> AIG
  SUM -- local --> LLM
  WFI --> R2
  QCR --> SINK
  WFI --> SINK
  SINK -- prod --> PIPE --> CAT
  SINK -- local --> R2
  R2 -. "datatrust lake sync (local only)" .-> ICE
```

The Worker never holds warehouse credentials and never sends free-form SQL. A Python runner (on a laptop or in CI) leases jobs from the Worker over HTTPS, runs dbt and the diagnostic probes against the warehouse, sanitizes the probe output, and posts results back. The root-cause logic is one TypeScript package used by both the Worker and the offline benchmark.

## What runs where

Local stand-ins are labelled as stand-ins. They are never presented as the production service.

| Concern | Local and CI (offline) | Production |
|---|---|---|
| HTTP API, queue consumers, workflows | `wrangler dev --local` (Miniflare, workerd) on 127.0.0.1:8792 | Cloudflare Workers, Queues, Workflows |
| Metadata store | D1 (Miniflare) | D1 `datatrust` |
| Artifacts | R2 (Miniflare) bucket `datatrust-artifacts` | R2 `datatrust-artifacts` |
| Warehouse | **DuckDB 1.5.6 via dbt-duckdb 1.11.0 (stand-in for BigQuery)**, session pinned to UTC | BigQuery via dbt-bigquery 1.12.1 |
| BigQuery SQL validity | BigQuery macro branches rendered and checked for banned constructs; nothing executes on BigQuery | `datatrust prod validate`: compile, `dbt build --empty`, dry runs of every probe |
| Restricted / authorized views | plain DuckDB views (stand-in) | BigQuery authorized view over an untagged aggregate table |
| Column masking | none (stand-in: sanitizer and tests) | BigQuery policy tags and data masking policies |
| Time travel / recovery | per-run Parquet snapshots of marts (stand-in) | `FOR SYSTEM_TIME AS OF`, 7-day window, `bq cp table@<ms>` restore |
| Iceberg lake | **pyiceberg SqlCatalog on SQLite (stand-in for Basin Catalog)** | Basin Pipelines stream to a Basin Catalog Iceberg table |
| LLM summaries | **llama-server (Qwen3-1.7B Q4_0) on 127.0.0.1:8160 (stand-in)** or a deterministic template (CI) | Workers AI `@cf/meta/llama-3.3-70b-instruct-fp8-fast` through AI Gateway `datatrust` |
| Auth | locally generated RS256 keypair and JWKS | Cloudflare Access (team JWKS) |
| Runner identity | local dev JWT (role `runner`) | Access service token `datatrust-runner` |
| Probe identity | DuckDB connection opened read-only | impersonated service account `datatrust-prober`, dry run plus byte cap |
| Lineage | `dbt-ol` file transport, uploaded by the runner | same |

## Local setup

Planned. Prerequisites will be Node 24 or newer, npm, [uv](https://docs.astral.sh/uv/) and Python 3.12. Commands land with the scaffold commit.

## Production setup

Planned. Production needs a Cloudflare account (Workers Paid plan, R2, Zero Trust) and a Google Cloud project with billing. The full ordered checklist with costs is SPEC.md section 21; it will be copied here together with `npm run setup:prod` and `npm run doctor -- --prod` when those scripts exist.

## Results

No results yet. This section will quote only numbers produced by this repo's scripts, each with the command and date that produced it. Benchmark numbers will come from DuckDB 1.5.6 as the local stand-in for BigQuery.

## License

MIT. See [LICENSE](LICENSE).
