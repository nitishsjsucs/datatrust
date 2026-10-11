"""Summary faithfulness eval (SPEC 12.4, stretch): run the seed-101 incidents through a summarizer and report
JSON validity, grounding pass rate, repair rate, template fallback rate, whether the root cause named by an
accepted LLM draft is in the ranker's top 3, and the PII leak count (must be 0).

Providers: `template` (deterministic), `local-llm` (llama-server with Qwen3-1.7B, the local stand-in for
Workers AI) and `workers-ai` (stretch, SPEC 28.5.5): the same bundles posted one at a time to the deployed
Worker's `POST /api/eval/summary`, which runs the grounded loop on Workers AI under the daily neuron ledger. That
run is resumable: each finished incident is appended to a checkpoint file, and the eval stops for the day when
the ledger has less than one incident's worst case left; rerunning it resumes. Only Nitish runs it.
"""

from __future__ import annotations

import datetime as dt
import json
import time
from collections import Counter
from pathlib import Path
from typing import Any

from datatrust.bench.harness import run_bench, trial_specs
from datatrust.bench.pii import find_leaks, pii_strings
from datatrust.bench.report import git_commit, versions
from datatrust.rca_cli import rca

RULES = (
    ("schema:", "schema"),
    ("unknown placeholder", "unknown placeholder"),
    ("outside a placeholder", "number outside a placeholder"),
    ("email address", "email"),
    ("phone number", "phone"),
    ("untokenized identifier", "untokenized identifier"),
    ("not one of the top five", "root cause not in top five"),
    ("evidenceRefs: unknown key", "unknown evidence ref"),
    ("diagnosticSqlIds: unknown id", "unknown diagnostic SQL id"),
    ("provider error", "provider error"),
)


def violation_rule(v: str) -> str:
    """The grounding rule (SPEC 13.7) a violation message belongs to."""
    return next((name for needle, name in RULES if needle in v), "other")


def detected_trials(seed: int, *, workers: int = 4, work_dir: Path | None = None) -> list[dict[str, Any]]:
    """The seed's offline trials (one per scenario, DuckDB stand-in) whose failure was detected."""
    return [
        r
        for r in run_bench(
            trial_specs([seed], clean=False), work_dir=work_dir, workers=workers, progress=False
        )
        if r["detected"]
    ]


def row_from_outcome(r: dict[str, Any], out: dict[str, Any], pii: dict[str, set[str]]) -> dict[str, Any]:
    top3 = [c["node"] for c in r["evidence"]["candidates"][:3]]
    texts = {
        f"{r['trial']}:summary": json.dumps(out["summary"]),
        **{f"{r['trial']}:draft{i}": d for i, d in enumerate(out["rawDrafts"])},
    }
    return {
        "trial": r["trial"],
        "scenario": r["scenario"],
        "attempts": out["attempts"],
        "firstDraftJson": out["firstDraftJson"],
        "firstDraftGrounded": out["firstDraftGrounded"],
        "repaired": out["repaired"],
        "fallback": out["fallback"],
        "violations": out["violations"],
        "rootCause": out["draft"]["suspectedRootCause"]["node"],
        "rootCauseInTop3": out["draft"]["suspectedRootCause"]["node"] in top3,
        "groundTruthInTop3": r["groundTruth"] in top3,
        "piiLeaks": find_leaks(texts, pii),
        "summary": out["summary"],
    }


def summarize_rows(rows: list[dict[str, Any]]) -> dict[str, Any]:
    n = len(rows)
    accepted = [x for x in rows if not x["fallback"]]
    rules = Counter(violation_rule(v) for x in rows for v in x["violations"])
    return {
        "incidents": n,
        "jsonValidRate": sum(x["firstDraftJson"] for x in rows) / n if n else 0,
        "groundingPassRate": sum(x["firstDraftGrounded"] for x in rows) / n if n else 0,
        "repairRate": sum(x["repaired"] for x in rows) / n if n else 0,
        "fallbackRate": sum(x["fallback"] for x in rows) / n if n else 0,
        "acceptedDrafts": len(accepted),
        "acceptedRootCauseInTop3": sum(x["rootCauseInTop3"] for x in accepted),
        "piiLeaks": sum(len(x["piiLeaks"]) for x in rows),
        "violationKinds": dict(rules.most_common(10)),
    }


def evaluate_summaries(
    seed: int, provider: str, *, llm_url: str, workers: int = 4, work_dir: Path | None = None
) -> dict[str, Any]:
    t0 = time.perf_counter()
    trials = detected_trials(seed, workers=workers, work_dir=work_dir)
    pii = pii_strings(seed)
    rows = []
    for r in trials:
        out = rca("summarize", {"evidence": r["evidence"], "provider": provider, "llmUrl": llm_url})
        rows.append(row_from_outcome(r, out, pii))
    return {
        "meta": {
            "date": dt.date.today().isoformat(),
            "seed": seed,
            "provider": provider,
            "model": "template-v1"
            if provider == "template"
            else "Qwen3-1.7B Q4_0 via llama-server (local stand-in for Workers AI)",
            "gitCommit": git_commit(),
            "versions": versions(),
            "wallSeconds": round(time.perf_counter() - t0, 1),
        },
        "summary": summarize_rows(rows),
        "rows": rows,
    }


# One incident reserves at most 187 + 201 neurons (apps/worker/src/llm/budget.ts, SPEC 28.5.5).
NEURONS_PER_INCIDENT_MAX = 388
RESUME = "resume after 00:00 UTC (rerun the same command; finished incidents are kept in the checkpoint)"


def evaluate_workers_ai(
    seed: int,
    client: Any,
    checkpoint: Path,
    *,
    trials: list[dict[str, Any]] | None = None,
    pii: dict[str, set[str]] | None = None,
    workers: int = 4,
    work_dir: Path | None = None,
) -> dict[str, Any]:
    """Resumable Workers AI eval. Returns {"done", "total", "stopped"} and, once every incident is finished,
    "report". `client` is the operator WorkerClient for the deployed Worker."""
    t0 = time.perf_counter()
    trials = trials if trials is not None else detected_trials(seed, workers=workers, work_dir=work_dir)
    pii = pii if pii is not None else pii_strings(seed)
    finished: dict[str, dict[str, Any]] = {}
    if checkpoint.exists():
        for line in checkpoint.read_text().splitlines():
            if line.strip():
                row = json.loads(line)
                finished[row["trial"]] = row
    checkpoint.parent.mkdir(parents=True, exist_ok=True)
    stopped = None
    for r in trials:
        if r["trial"] in finished:
            continue
        budget = client.ai_budget()
        if int(budget.get("headroom", 0)) < NEURONS_PER_INCIDENT_MAX:
            stopped = f"Workers AI headroom is {budget.get('headroom')} neurons on {budget.get('day')} UTC; {RESUME}"
            break
        out = client.request("POST", "/api/eval/summary", json={"evidence": r["evidence"]}).json()
        if out.get("refused"):
            stopped = f"the daily neuron cap refused a call on {out.get('day')} UTC; {RESUME}"
            break
        row = {
            **row_from_outcome(r, out, pii),
            "day": out["day"],
            "neurons": out["neurons"],
            "model": out["model"],
        }
        with checkpoint.open("a") as fh:
            fh.write(json.dumps(row, default=str) + "\n")
        finished[r["trial"]] = row
    result: dict[str, Any] = {"done": len(finished), "total": len(trials), "stopped": stopped}
    if stopped is None and len(finished) == len(trials):
        rows = [finished[r["trial"]] for r in trials]
        per_day: dict[str, dict[str, int]] = {}
        for x in rows:
            d = per_day.setdefault(x["day"], {"incidents": 0, "reserved": 0, "used": 0})
            d["incidents"] += 1
            d["reserved"] += x["neurons"]["reserved"]
            d["used"] += (
                x["neurons"]["used"] if x["neurons"]["used"] is not None else x["neurons"]["reserved"]
            )
        summary = {**summarize_rows(rows), "neuronsPerDay": per_day}
        result["report"] = {
            "meta": {
                "date": dt.date.today().isoformat(),
                "seed": seed,
                "provider": "workers-ai",
                "model": f"{rows[0]['model']} via AI Gateway (production Worker)" if rows else "workers-ai",
                "gitCommit": git_commit(),
                "versions": versions(),
                "wallSeconds": round(time.perf_counter() - t0, 1),
                "checkpoint": str(checkpoint),
            },
            "summary": summary,
            "rows": rows,
        }
    return result


def write_summary_report(report: dict[str, Any], out_dir: Path, command: str) -> tuple[Path, Path]:
    m, s = report["meta"], report["summary"]
    name = f"summaries-{m['date']}-{m['provider']}"
    out_dir.mkdir(parents=True, exist_ok=True)
    jpath = out_dir / f"{name}.json"
    jpath.write_text(json.dumps({**report, "meta": {**m, "command": command}}, indent=1, default=str) + "\n")
    pct = lambda x: f"{100 * x:.0f}%"  # noqa: E731
    lines = [
        f"# Summary faithfulness eval, {m['provider']}, {m['date']}",
        "",
        f"- Command: `{command}`",
        f"- Git commit: `{m['gitCommit']}`",
        f"- Summarizer: {m['model']}",
        f"- Incidents: {s['incidents']} (seed {m['seed']}, every scenario, offline trials on DuckDB, the local stand-in for BigQuery)",
        "",
        "| Metric | Value |",
        "|---|---|",
        f"| First draft is a JSON object | {pct(s['jsonValidRate'])} |",
        f"| First draft passes grounding | {pct(s['groundingPassRate'])} |",
        f"| Accepted after one repair | {pct(s['repairRate'])} |",
        f"| Template fallback | {pct(s['fallbackRate'])} |",
        f"| Accepted drafts naming a top-3 root cause | {s['acceptedRootCauseInTop3']}/{s['acceptedDrafts']} |",
        f"| PII leaks (names, emails, phones, birth dates, salaries) | {s['piiLeaks']} |",
        "",
        *(
            [
                "Workers AI neurons per UTC day: "
                + ", ".join(
                    f"{day} {d['incidents']} incidents, {d['used']} used ({d['reserved']} reserved)"
                    for day, d in sorted(s["neuronsPerDay"].items())
                ),
                "",
            ]
            if s.get("neuronsPerDay")
            else []
        ),
        "Grounding violations by rule, on the final attempt of each incident: "
        + (", ".join(f"{k} ({v})" for k, v in s["violationKinds"].items()) or "none"),
        "",
        "| Trial | Attempts | Grounded first | Repaired | Fallback | Root cause | In top 3 |",
        "|---|---|---|---|---|---|---|",
    ]
    for x in report["rows"]:
        lines.append(
            f"| {x['trial']} | {x['attempts']} | {x['firstDraftGrounded']} | {x['repaired']} | {x['fallback']} | "
            f"{x['rootCause'].split('.')[-1]} | {x['rootCauseInTop3']} |"
        )
    mpath = out_dir / f"{name}.md"
    mpath.write_text("\n".join(lines) + "\n")
    return jpath, mpath
