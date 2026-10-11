# ADR-0008: Production on the Cloudflare Workers Free plan

- Status: accepted, 2026-10-10
- Supersedes: the Basin Pipelines lake sink and the Workers Paid setup step of SPEC 1.1 (sections 13.9, 18.1 steps 5 to 7, 21.1 row 2)

## Context

Nitish decided to keep the Cloudflare account on the Workers Free plan. On 2026-10-10 his account confirmed the consequences: creating a Basin Pipelines resource fails with "This feature requires a Workers Paid plan [code: 1021]", while creating a Queue and enabling Basin Catalog on an R2 bucket both work. The account, and the Google Cloud project `master-magnet-444903-u4`, are shared by four repos, so account-wide daily allowances are shared too.

Measured against the Free limits (SPEC 28.3, 28.4), the v1.1 design had one Paid-only dependency and several Free-limit violations:

- The production lake sink was a Basin Pipelines stream (Paid only), and the production guard refused to serve without it.
- A lineage POST of 50 events took 17 to 20 ms of CPU cold (Free: 10 ms) and 51 D1 statements (Free: 50 queries per invocation).
- One queue message per OpenLineage event made a failing run cost 429 queue operations; the 6-run smoke alone would use 103% of a 25% share of the account's 10,000 per day.
- Queue consumers wrote up to 200 statements per invocation.
- The first `localeCompare` in an isolate builds an ICU collator (about 5 ms), which pushed cold `rank` and `trace` plus `plan` steps to 7 to 8 ms.
- An idle runner polled every 2 s, 43,200 requests per day.
- Workers AI on Free has no overage, but v1.1 priced summaries as Paid overage.

## Decision

1. No Workers Paid feature in production. A test pins the production config (no `pipelines`, `limits`, cron, Logpush or non-SQLite Durable Objects).
2. Audit events go from the Worker to Queue `datatrust-audit-events`, whose consumer writes each batch as one immutable NDJSON object in R2. `datatrust lake commit` (pyiceberg) adds them to the Basin Catalog Iceberg table once per `event_id`, moving its cursor in the same Iceberg commit. Local and CI run the same path against a SQLite catalog.
3. Lineage arrives in POSTs of at most 10 events and 256 KB, each announced by one queue message; multi-row D1 writes are single set-based statements; request sizes are capped.
4. Identifier ordering uses an `Intl.Collator` built at module scope, with the same order as before.
5. Workers AI keeps `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (the only active model in the JSON-mode list). A D1 ledger reserves each call's worst-case neurons against `AI_DAILY_NEURON_CAP = 2000` per UTC day and falls back to the template beyond it; each AI call is its own Workflow step.
6. Every account-wide allowance is budgeted at a 25% share for DataTrust, every resource name starts with `datatrust`, and Google Cloud grants stay dataset- or resource-scoped with every query capped.
7. The runner backs off to 30 s when idle; an existing incident stops a second investigation after the 3-day Free Workflows retention.

## Consequences

- Cost: $0 on Cloudflare. The smoke uses at most 26% of DataTrust's share of any daily allowance except Workers AI, whose worst case (1,907 neurons) stays under the code-enforced cap; the typical smoke uses 432 neurons.
- Throughput within the share: about 20 validation runs per day; at least 5 Workers AI summaries per day in the worst case (about 23 typically), then template summaries with the reason stored on the incident.
- Iceberg rows appear when the committer runs rather than continuously; the R2 objects are the durable record in between.
- The resume wording is unaffected: Queues, Workflows, Workers AI through AI Gateway, and OpenLineage all run on the Free plan. The production smoke is still required before the wording claims production use (ADR-0003).
- Unverified items (Free CPU for queue consumers, how D1 counts a batch, edge CPU speed, Workflows behavior at 3,000 steps per day) are listed in SPEC 24 and 25.4; the design is sized to the strictest reading of each.
