# DataTrust domain language

Terms as they are used in code, tests and docs. Decisions behind them are in `docs/adr/`; the full design is
`SPEC.md`.

**Run**: one validation of a warehouse build, started by `POST /api/runs` (target `duckdb` or `bigquery`,
seed, optional scenario). A run is `queued`, `running`, then `passed`, `failed`, `stale` (no build arrived
in time) or `error`. One ValidationRunWorkflow instance per run, with the run id as its instance id.

**Runner**: the Python process that does warehouse work for the Worker. It leases **jobs** over HTTPS
(outbound only): `dbt_build` (generate, inject, load, `dbt-ol build`) and `diagnostics` (run probes). A
**lease** carries a token; every job call must present it. A job is leased at most three times. A lease past
its expiry still holds until another runner re-leases the job, and a completion may be retried with the same
token. A job older than its workflow's wait (6 hours for a build, 1 hour for diagnostics) is **failed**, never
leased: nothing would receive its result. BigQuery runs go one at a time, because each builds the same
`datatrust_*` datasets.

**Principal** and **role**: who calls the Worker, resolved from the verified Access JWT. Humans are matched on
email, service tokens on `common_name` (the Client ID). Roles: `viewer` (read runs and incidents),
`operator` (also start runs and post alerts) and `runner` (lease jobs, post results, lineage and alerts). In
production the service token `datatrust-runner` holds only `runner`; `datatrust-operator` holds `operator`
and `viewer` for the CLI (`datatrust run --env prod`) and the smoke test.

**Check**: one of the 40 dbt test nodes named `dq_*`, listed in `checks/registry.yml` with a category
(uniqueness, referential, interval, stage_transition, compensation, reconciliation), a tested node and
columns, and for singular SQL tests the further nodes it reads (`also`). A **CheckResult** is one check's
outcome in one run. An enforced **contract** failure or a model build error is also reported as a
CheckResult (`schema_contract`, `model_error`), but contracts are not counted among the 40 checks.

**Failed metric**: a failing reconciliation check on a `metric_*` model (X02 to X04), or an **alert** naming a
metric model: posted to `/api/alerts`, or reported by the **metric watch**. Both start an investigation.

**Metric watch**: after a build whose checks all passed, the runner compares every metric model (dbt meta
`metric` and `grain`) cell by cell with the last green run's snapshot of the same seed. The calendar is closed,
so a moved, missing or duplicated department-month means the metric failed; the runner reports the metric with
the largest share of moved cells with the build, the run ends `failed` and gets one alert investigation, and the
run leaves no snapshot (restated history never becomes the baseline). The offline benchmark runs the same
comparison against a clean build and traces each trial a second time from that failed metric alone.

**Lineage graph**: nodes are dbt unique ids (sources and models); column edges come from OpenLineage
`columnLineage` facets, dataset edges from event inputs and outputs. OpenLineage dataset names are matched
on (schema, table) only, never on namespace (which embeds the warehouse path).

**Candidate**: a node in the upstream closure of the failing checks. **Trace** builds the candidate set,
**plan** chooses **probes** from node meta, **rank** scores candidates. **Own anomaly** is a probe's
anomaly minus the same probe's anomaly on the node's lineage-mapped parents, so an inherited problem is
discounted.

**Probe**: a read-only SQL template (one per kind, `pipelines/datatrust/diagnostics/templates/`) rendered by
the runner from its own manifest, never from SQL sent by the Worker. A **probe result** carries an
aggregate value, an anomaly score from 0 to 1, the SQL text and at most five **sample keys**.

**Sanitize**: turn identifier sample keys into HMAC tokens with an entity prefix (`emp_3fa09c1b2e`) and drop
PII, compensation amounts and free text. Pseudonymization, not anonymization. Done in the runner before
upload and re-checked by the Worker.

**Evidence**: the sanitized failing checks, top candidates and supporting probes of one incident, each with
a **key** a summary can cite as `{ev:<key>.<field>}`. **Grounding**: a summary draft is accepted only if
every placeholder resolves, no digit appears outside placeholders and known identifiers, the root cause is a
top-five candidate and nothing looks like PII.

**Incident**: the persisted outcome of one investigation: failing checks, lineage path, ranked candidates,
evidence, diagnostic SQL, summary, recovery commands and **provenance** (warehouse, summarizer, lake sink),
in D1 and R2. One incident per failing run, plus one per distinct alert.

**Audit event**: one row of the lake (`check_result`, `run_completed`, `incident_created`) with a
deterministic **event id** (`evt_<runId>_check_<checkId>`, `evt_<runId>_run_completed`,
`evt_<incidentId>_created`), so a redelivery repeats the id instead of adding a row. Events travel through
queue `datatrust-audit-events`; its consumer writes each batch as one immutable **lake object**
(`lake/<date>/<ulid>.ndjson` in R2). An object is **settled** once its ULID time is older than the settle
window (120 s in production), and only settled objects are exported to the Iceberg table.

**Lineage bundle**: the OpenLineage events of one `POST /api/v1/lineage` (at most 10 events and 256 KB),
stored in R2 and announced by one message on `datatrust-lineage-events`; its consumer writes their edges and
`lineage_events` rows with two set-based statements.

**Neuron ledger**: the `ai_budget` table in D1, one row per UTC day. Every Workers AI call first reserves its
worst-case neurons there and is refused once the day's reservations would pass `AI_DAILY_NEURON_CAP` (2,000);
a refused summary falls back to the template with reason `daily_neuron_cap`.

**Prune**: removing the lineage detail of runs older than N days (at least 7) through `POST /api/admin/prune`
(operator, `datatrust prune`): their D1 lineage edges, events and nodes and their raw OpenLineage events under R2
`lineage/<runId>/`. Run rows, jobs, check results, incidents and the audit lake stay, and so does the latest
passed run, whose model checksums are the next investigation's baseline. At most 5 runs per call, because
deleted rows count as rows written; the **prune ledger** (`prune_budget`, one row per UTC day) stops pruning
for the day before 5,000 rows written.

**Builder**: the service account `datatrust-builder` that the raw loads and dbt impersonate in production
(`DATATRUST_BUILDER_SA`). It owns the four `datatrust_*` datasets and can read nothing else in the shared
project. The **prober** (`datatrust-prober`) runs the read-only probes; the **analyst** (`datatrust-analyst`)
is the masked reader that governance verify impersonates.

**Share**: the 25% of an account-wide Free plan allowance that DataTrust budgets for itself, because four repos
use the same Cloudflare account and Google Cloud project.

**Scenario**: one of the 20 injected defects of the benchmark (S01-S13 change source data, T14-T20 patch
the dbt project), each with a **ground truth** node. **Decoy**: a benign refactor patch that changes a
model's checksum but not its output; 0 to 4 per **trial**. A trial is one (seed, scenario) build; dev seeds
1-3 tune the weights, test seeds 101-105 are reported.

**Stand-in**: a local substitute for a production service (DuckDB for BigQuery, Miniflare for Cloudflare,
llama-server or the template for Workers AI, a pyiceberg SQL catalog for Basin Catalog, local RS256 keys for
Access). Always labelled as such (ADR-0003).
