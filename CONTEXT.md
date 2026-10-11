# DataTrust domain language

Terms as they are used in code, tests and docs. Decisions behind them are in `docs/adr/`; the full design is
`SPEC.md`.

**Run**: one validation of a warehouse build, started by `POST /api/runs` (target `duckdb` or `bigquery`,
seed, optional scenario). A run is `queued`, `running`, then `passed`, `failed`, `stale` (no build arrived
in time) or `error`. One ValidationRunWorkflow instance per run, with the run id as its instance id.

**Runner**: the Python process that does warehouse work for the Worker. It leases **jobs** over HTTPS
(outbound only): `dbt_build` (generate, inject, load, `dbt-ol build`) and `diagnostics` (run probes). A
**lease** carries a token; every job call must present it. A job is leased at most three times.

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

**Failed metric**: a failing reconciliation check on a `metric_*` model (X02 to X04), or an **alert** posted
to `/api/alerts` naming a metric model. Both start an investigation.

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

**Scenario**: one of the 20 injected defects of the benchmark (S01-S13 change source data, T14-T20 patch
the dbt project), each with a **ground truth** node. **Decoy**: a benign refactor patch that changes a
model's checksum but not its output; 0 to 4 per **trial**. A trial is one (seed, scenario) build; dev seeds
1-3 tune the weights, test seeds 101-105 are reported.

**Stand-in**: a local substitute for a production service (DuckDB for BigQuery, Miniflare for Cloudflare,
llama-server or the template for Workers AI, a pyiceberg SQL catalog for Basin Catalog, local RS256 keys for
Access). Always labelled as such (ADR-0003).
