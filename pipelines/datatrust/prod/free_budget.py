"""Workers Free plan budget model (SPEC 28.2, 28.6, 28.7, ADR-0008).

The Cloudflare account and the Google Cloud project are shared by four repos, so every account-wide daily
allowance is budgeted at a 25% share for DataTrust. Per-run counts are derived from the code where the code
fixes them (runner batching, the Worker's message sizes, consumer settings in the production template,
workflow step names and retry limits) and from the committed seed-101 fixtures; the rest are either measured
locally (MEASURED, SPEC 28.3) or estimates (ESTIMATED), each with its source. `test_free_budget.py` pins the
result; `uv run python -m datatrust.prod.free_budget` prints the table quoted in the README.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml

from datatrust import config
from datatrust.runner.client import LINEAGE_POST_MAX_BYTES, LINEAGE_POST_MAX_EVENTS
from datatrust.runner.loop import IDLE_INTERVAL_MAX, IDLE_INTERVAL_START

ROOT = config.REPO_ROOT
WORKER = ROOT / "apps" / "worker"
SHARE = 0.25
SMOKE_CLEAN_RUNS = 1
SMOKE_FAILING_RUNS = 5


@dataclass(frozen=True)
class Allowance:
    name: str
    amount: float
    unit: str
    url: str


# SPEC 28.2, checked against the official pages on 2026-10-10.
ALLOWANCES: dict[str, Allowance] = {
    "requests": Allowance(
        "Workers requests", 100_000, "per day", "https://developers.cloudflare.com/workers/platform/limits/"
    ),
    "queue_ops": Allowance(
        "Queue operations", 10_000, "per day", "https://developers.cloudflare.com/queues/platform/pricing/"
    ),
    "workflow_steps": Allowance(
        "Workflow steps", 3_000, "per day", "https://developers.cloudflare.com/workflows/reference/limits/"
    ),
    "d1_rows_written": Allowance(
        "D1 rows written", 100_000, "per day", "https://developers.cloudflare.com/d1/platform/pricing/"
    ),
    "d1_rows_read": Allowance(
        "D1 rows read", 5_000_000, "per day", "https://developers.cloudflare.com/d1/platform/pricing/"
    ),
    "neurons": Allowance(
        "Workers AI neurons",
        10_000,
        "per day",
        "https://developers.cloudflare.com/workers-ai/platform/pricing/",
    ),
    "logs": Allowance(
        "Workers Logs events",
        200_000,
        "per day",
        "https://developers.cloudflare.com/workers/observability/logs/workers-logs/",
    ),
    "r2_class_a": Allowance(
        "R2 Class A operations", 1_000_000, "per month", "https://developers.cloudflare.com/r2/pricing/"
    ),
    "r2_class_b": Allowance(
        "R2 Class B operations", 10_000_000, "per month", "https://developers.cloudflare.com/r2/pricing/"
    ),
    "r2_storage_mb": Allowance(
        "R2 storage (MB-month)", 10_000, "per month", "https://developers.cloudflare.com/r2/pricing/"
    ),
}
# Per-invocation limits (SPEC 28.2): 50 D1 queries, 10 ms CPU, 1,000 Cloudflare and 50 external subrequests.
D1_QUERIES_PER_INVOCATION = 50
CPU_MS_PER_INVOCATION = 10
QUEUE_OPS_PER_MESSAGE = 3  # write, read, delete; one each per 64 KB, and every message stays below 64 KB
QUEUE_MESSAGE_OPERATION_BYTES = 64 * 1024

# Measured figures (SPEC 28.3): from the local Miniflare D1 and R2 state of 71 e2e runs and from the committed
# seed-101 fixtures and prompts. Not derivable from the code.
MEASURED = {
    "lineage_edges_per_run": 275,  # 50 dataset and 225 column edges, local Miniflare state of 71 runs
    "largest_event_bytes": 21_000,  # largest single seed-101 dbt-ol event
    "r2_class_a_per_run": 150,  # about 135 lineage objects plus run artifacts written per run (local R2 state)
    "r2_mb_per_run": 0.94,  # local R2 state over 71 runs
    "largest_prompt_chars": 3_909,  # the 20 seed-101 summary prompts
    "largest_repair_prompt_chars": 5_430,
}
# Estimates (2026-10-11 review: these were filed under MEASURED before). Each says what it rests on; none was
# observed on Cloudflare or BigQuery, where nothing has run yet.
ESTIMATED = {
    # Counted from the schema (rows plus index entries for jobs, runs, the incident and the neuron ledger).
    "d1_rows_written_other": 16 + 5 + 3 + 6,
    # Extrapolated from the 71 local runs to 3,000 stored runs (index scans grow with the tables).
    "d1_rows_read_per_run": 9_000,
    # Reads of lineage objects, artifacts and incidents per run, from the code's access pattern.
    "r2_class_b_per_run": 175,
    # No local source for Workers Logs; an allowance for the log lines of one run's requests and steps.
    "logs_per_run": 250,
    # An assumed BigQuery run of about 12.5 minutes (the operator polls throughout); BigQuery has not run.
    "run_seconds": 750,
    # Qwen3-1.7B token counts of the seed-101 prompts plus 25% for Llama 3.3's tokenizer (SPEC risk 28):
    # one call typical, two calls with full 700-token outputs worst.
    "neurons_typical_per_incident": 86,
    "neurons_worst_per_incident": 382,
}
SMOKE_OPERATOR_POLL_SECONDS = 5  # prod/smoke.py wait_for_run


# ------------------------------------------------------------------------------------------- code facts


def jsonc(text: str) -> dict[str, Any]:
    """JSONC to JSON: drop // comments outside strings."""
    out, in_string, i = [], False, 0
    while i < len(text):
        ch = text[i]
        if in_string:
            out.append(ch)
            if ch == "\\":
                out.append(text[i + 1])
                i += 1
            elif ch == '"':
                in_string = False
        elif ch == '"':
            in_string = True
            out.append(ch)
        elif text.startswith("//", i):
            while i < len(text) and text[i] != "\n":
                i += 1
            continue
        else:
            out.append(ch)
        i += 1
    return json.loads("".join(out))


@lru_cache(maxsize=1)
def production_config() -> dict[str, Any]:
    text = (WORKER / "wrangler.prod.template.jsonc").read_text()
    return jsonc(text.replace("${D1_DATABASE_ID}", "x").replace("${ACCESS_TEAM_DOMAIN}", "https://x"))


def ts_constant(path: Path, name: str) -> int:
    m = re.search(rf"export const {name} = ([\d_]+);", path.read_text())
    if not m:
        raise ValueError(f"{name} not found in {path}")
    return int(m.group(1).replace("_", ""))


def workflow_step_names() -> set[str]:
    names: set[str] = set()
    for f in ("validation-run.ts", "investigation.ts"):
        text = (WORKER / "src" / "workflows" / f).read_text()
        names |= set(re.findall(r"jsonStep(?:<[^>]+>)?\(\s*step,\s*'([a-z-]+)'", text))
        names |= set(re.findall(r"waitForEvent<[^>]+>\('([a-z-]+)'", text))
    return names


def retry_limit(name: str) -> int:
    text = (WORKER / "src" / "workflows" / "steps.ts").read_text()
    m = re.search(rf"export const {name}: WorkflowStepConfig = \{{\s*retries: \{{ limit: (\d+)", text)
    if not m:
        raise ValueError(f"{name} not found")
    return int(m.group(1))


@lru_cache(maxsize=1)
def seed101_relations() -> dict[str, Any]:
    return json.loads(
        (ROOT / "packages" / "rca" / "test" / "fixtures" / "relations.seed101.json").read_text()
    )


def lineage_events_per_run() -> int:
    """dbt-ol emits START and COMPLETE for every model and test node, plus the job's own pair."""
    models = sum(1 for n in seed101_relations()["nodes"].values() if n["kind"] == "model")
    checks = len(yaml.safe_load((ROOT / "checks" / "registry.yml").read_text())["checks"])
    return 2 * (models + checks) + 2


def lineage_nodes_per_run() -> int:
    """Sources and models of the seed-101 relations: one lineage_nodes row each."""
    return len(seed101_relations()["nodes"])


def prune_rows_per_run() -> int:
    """D1 rows written to prune one run's lineage (POST /api/admin/prune): every deleted edge, event and node
    row, plus its primary-key index entry, which the D1 pricing page counts as another written row. Miniflare
    counts the rows only (half of this, prune.test.ts), so this is the upper bound the Worker's ledger uses."""
    return 2 * (MEASURED["lineage_edges_per_run"] + lineage_events_per_run() + lineage_nodes_per_run())


VALIDATION_STEPS_FAILING = (
    "register-run",
    "enqueue-build",
    "wait-build",
    "await-ingested",
    "summarize-run",
    "dispatch-investigation",
    "finalize",
)
INVESTIGATION_STEPS = (
    "load-context",
    "trace-lineage",
    "plan-probes",
    "request-diagnostics",
    "wait-diagnostics",
    "rank",
    "sanitize",
    "summarize-draft",
    "summarize-finalize",
    "persist-incident",
)
# Steps that run only on a worse path of a failing run: a repair draft, and failing the diagnostics job when
# its wait times out. Both count in the worst case.
INVESTIGATION_EXTRA_STEPS = ("summarize-repair", "expire-diagnostics")


# ------------------------------------------------------------------------------------------- per run


@dataclass(frozen=True)
class Run:
    lineage_posts: int
    queue_messages: int
    queue_ops: int
    workflow_steps_typical: int
    workflow_steps_worst: int
    requests: int
    d1_rows_written: int
    d1_rows_read: int
    neurons_typical: int
    neurons_worst: int
    r2_class_a: int
    r2_class_b: int
    r2_mb: float
    logs: int


def idle_polls(seconds: float) -> int:
    """Lease polls of an idle runner over `seconds` with the backoff (2 s doubling to 30 s)."""
    n, t, wait = 0, 0.0, IDLE_INTERVAL_START
    while t < seconds:
        n += 1
        t += wait
        wait = min(wait * 2, IDLE_INTERVAL_MAX)
    return n


def reservation_neurons(prompt_chars: int) -> int:
    """The Worker's worst-case reservation (apps/worker/src/llm/budget.ts), same formula."""
    schema_chars = 971  # JSON.stringify of the summary schema sent with every call (pinned in budget.test.ts)
    tokens = math.ceil((prompt_chars + schema_chars) / 3)
    return math.ceil(tokens * 26_668 / 1e6 + 700 * 204_805 / 1e6)


def per_run(failing: bool) -> Run:
    events = lineage_events_per_run()
    # The runner packs at most 10 events and 256 KB per POST; with the largest events the count decides.
    per_post = min(LINEAGE_POST_MAX_EVENTS, LINEAGE_POST_MAX_BYTES // MEASURED["largest_event_bytes"])
    posts = math.ceil(events / per_post)
    checks = len(yaml.safe_load((ROOT / "checks" / "registry.yml").read_text())["checks"]) + 1  # + contract
    per_check_msg = ts_constant(WORKER / "src" / "api" / "runner.ts", "CHECK_RESULTS_PER_MESSAGE")
    audit_max = ts_constant(WORKER / "src" / "sinks" / "event-sink.ts", "AUDIT_MESSAGE_MAX_EVENTS")
    check_messages = math.ceil(checks / per_check_msg)
    audit_messages = math.ceil(checks / audit_max) + 1 + (1 if failing else 0)  # checks, run, incident
    messages = check_messages + posts + (1 if failing else 0) + audit_messages
    steps = len(VALIDATION_STEPS_FAILING) - (0 if failing else 1)
    steps_worst = steps + retry_limit("RETRY_INGEST")
    if failing:
        steps += len(INVESTIGATION_STEPS)
        steps_worst += (
            len(INVESTIGATION_STEPS)
            + len(INVESTIGATION_EXTRA_STEPS)
            + retry_limit("RETRY_LOAD")
            + 2 * retry_limit("RETRY_AI")
        )
    runner = 2 * (2 if failing else 1) + 2 + posts  # leases and completions per job, two artifacts, lineage
    runner_idle = idle_polls(ESTIMATED["run_seconds"])
    operator = ESTIMATED["run_seconds"] // SMOKE_OPERATOR_POLL_SECONDS + 1 + (1 if failing else 0)
    consumers = messages  # one invocation per message, the conservative reading (batches are often larger)
    requests = runner + runner_idle + operator + consumers + steps_worst
    rows = (
        2 * MEASURED["lineage_edges_per_run"]
        + 2 * events
        + 2 * lineage_nodes_per_run()
        + 2 * checks
        + ESTIMATED["d1_rows_written_other"]
    )
    return Run(
        lineage_posts=posts,
        queue_messages=messages,
        queue_ops=QUEUE_OPS_PER_MESSAGE * messages,
        workflow_steps_typical=steps,
        workflow_steps_worst=steps_worst,
        requests=requests,
        d1_rows_written=rows,
        d1_rows_read=ESTIMATED["d1_rows_read_per_run"],
        neurons_typical=ESTIMATED["neurons_typical_per_incident"] if failing else 0,
        neurons_worst=ESTIMATED["neurons_worst_per_incident"] if failing else 0,
        r2_class_a=MEASURED["r2_class_a_per_run"],
        r2_class_b=ESTIMATED["r2_class_b_per_run"],
        r2_mb=MEASURED["r2_mb_per_run"],
        logs=ESTIMATED["logs_per_run"],
    )


# ------------------------------------------------------------------------------------------- the smoke


@dataclass(frozen=True)
class Line:
    key: str
    per_failing_run: float
    smoke: float
    share: float
    worst: bool = False

    @property
    def pct_of_share(self) -> float:
        return 100.0 * self.smoke / self.share

    @property
    def runs_per_day(self) -> int:
        return int(self.share // self.per_failing_run) if self.per_failing_run else 0


def ai_daily_neuron_cap() -> int:
    return int(production_config()["vars"]["AI_DAILY_NEURON_CAP"])


def smoke_lines() -> list[Line]:
    f, c = per_run(True), per_run(False)

    def total(attr: str) -> float:
        return SMOKE_FAILING_RUNS * getattr(f, attr) + SMOKE_CLEAN_RUNS * getattr(c, attr)

    def line(key: str, attr: str, worst: bool = False) -> Line:
        return Line(key, getattr(f, attr), total(attr), SHARE * ALLOWANCES[key].amount, worst)

    return [
        line("requests", "requests"),
        line("queue_ops", "queue_ops"),
        line("workflow_steps", "workflow_steps_worst", worst=True),
        line("d1_rows_written", "d1_rows_written"),
        line("d1_rows_read", "d1_rows_read"),
        line("neurons", "neurons_typical"),
        line("neurons", "neurons_worst", worst=True),
        line("logs", "logs"),
        line("r2_class_a", "r2_class_a"),
        line("r2_class_b", "r2_class_b"),
        line("r2_storage_mb", "r2_mb"),
    ]


def sustained_runs_per_day() -> int:
    """Failing runs per day inside the share, bound by the tightest daily metric (worst case)."""
    daily = [x for x in smoke_lines() if ALLOWANCES[x.key].unit == "per day" and x.key != "neurons"]
    return min(x.runs_per_day for x in daily)


def prune_daily_rows() -> int:
    return ts_constant(WORKER / "src" / "schemas.ts", "PRUNE_DAILY_ROWS")


def sustained_runs_per_day_pruned() -> int:
    """Failing runs per day once D1 is full (about 3,000 runs, SPEC risk 25) and every new run's lineage is
    pruned to make room: each run then also costs its prune deletes, and the Worker's prune ledger allows at
    most PRUNE_DAILY_ROWS of them per UTC day."""
    d1_share = SHARE * ALLOWANCES["d1_rows_written"].amount
    by_writes = int(d1_share // (per_run(True).d1_rows_written + prune_rows_per_run()))
    by_ledger = prune_daily_rows() // prune_rows_per_run()
    return min(sustained_runs_per_day(), by_writes, by_ledger)


def markdown() -> str:
    f = per_run(True)
    rows = [
        "| Metric | Free allowance (account) | DataTrust share (25%) | Per failing run | Smoke (1 clean + 5 failing) "
        "| Smoke, % of share |",
        "|---|---|---|---|---|---|",
    ]
    for x in smoke_lines():
        a = ALLOWANCES[x.key]
        label = a.name + (" (worst case)" if x.worst else " (typical)" if x.key == "neurons" else "")
        pct = "under 0.1%" if x.pct_of_share < 0.1 else f"{x.pct_of_share:.1f}%"
        rows.append(
            f"| {label} | {a.amount:,.0f} {a.unit} | {x.share:,.0f} | {x.per_failing_run:,.2f} | {x.smoke:,.1f} "
            f"| {pct} |".replace(".00 |", " |").replace(".0 |", " |")
        )
    rows += [
        "",
        f"- Per failing run: {f.lineage_posts} lineage POSTs, {f.queue_messages} queue messages "
        f"({f.queue_ops} operations), {f.workflow_steps_typical} workflow steps typical and "
        f"{f.workflow_steps_worst} with every designed retry.",
        f"- Workers AI: a summary reserves at most {reservation_neurons(MEASURED['largest_prompt_chars'])} + "
        f"{reservation_neurons(MEASURED['largest_repair_prompt_chars'])} neurons; the code caps a UTC day at "
        f"{ai_daily_neuron_cap():,}.",
        f"- Sustained failing runs per day inside the share: {sustained_runs_per_day()} (tightest daily metric) "
        f"while D1 has room; once D1 is full and each new run's lineage is pruned: "
        f"{sustained_runs_per_day_pruned()} (pruning a run writes up to {prune_rows_per_run()} D1 rows, and the "
        f"Worker's prune ledger allows {prune_daily_rows():,} a day).",
    ]
    return "\n".join(rows)


if __name__ == "__main__":
    print(markdown())
