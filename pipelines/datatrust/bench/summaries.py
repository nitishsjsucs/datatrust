"""Summary faithfulness eval (SPEC 12.4, stretch): run the seed-101 incidents through a summarizer and report
JSON validity, grounding pass rate, repair rate, template fallback rate, whether the root cause named by an
accepted LLM draft is in the ranker's top 3, and the PII leak count (must be 0).

Providers: `template` (deterministic) and `local-llm` (llama-server with Qwen3-1.7B, the local stand-in for
Workers AI). Workers AI numbers exist only after the production smoke (`npm run prod:smoke`).
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


def evaluate_summaries(
    seed: int, provider: str, *, llm_url: str, workers: int = 4, work_dir: Path | None = None
) -> dict[str, Any]:
    t0 = time.perf_counter()
    trials = [
        r
        for r in run_bench(
            trial_specs([seed], clean=False), work_dir=work_dir, workers=workers, progress=False
        )
        if r["detected"]
    ]
    pii = pii_strings(seed)
    rows = []
    for r in trials:
        out = rca("summarize", {"evidence": r["evidence"], "provider": provider, "llmUrl": llm_url})
        top3 = [c["node"] for c in r["evidence"]["candidates"][:3]]
        texts = {
            f"{r['trial']}:summary": json.dumps(out["summary"]),
            **{f"{r['trial']}:draft{i}": d for i, d in enumerate(out["rawDrafts"])},
        }
        rows.append(
            {
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
        )
    n = len(rows)
    accepted = [x for x in rows if not x["fallback"]]
    rules = Counter(violation_rule(v) for x in rows for v in x["violations"])
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
        "summary": {
            "incidents": n,
            "jsonValidRate": sum(x["firstDraftJson"] for x in rows) / n if n else 0,
            "groundingPassRate": sum(x["firstDraftGrounded"] for x in rows) / n if n else 0,
            "repairRate": sum(x["repaired"] for x in rows) / n if n else 0,
            "fallbackRate": sum(x["fallback"] for x in rows) / n if n else 0,
            "acceptedDrafts": len(accepted),
            "acceptedRootCauseInTop3": sum(x["rootCauseInTop3"] for x in accepted),
            "piiLeaks": sum(len(x["piiLeaks"]) for x in rows),
            "violationKinds": dict(rules.most_common(10)),
        },
        "rows": rows,
    }


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
        "Most common grounding violations: "
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
