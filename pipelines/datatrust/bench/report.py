"""Benchmark reports: results/bench-<date>-<mode>[-<tag>].json and .md (SPEC 12.3)."""

from __future__ import annotations

import datetime as dt
import json
import platform
import subprocess
from importlib import metadata
from pathlib import Path
from typing import Any

from datatrust import config

WAREHOUSE = "DuckDB 1.5.6 via dbt-duckdb 1.11.0, local stand-in for BigQuery"


def git_commit() -> str | None:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=config.REPO_ROOT, capture_output=True, text=True, check=True
        )
        dirty = subprocess.run(
            ["git", "status", "--porcelain", "--untracked-files=no"],
            cwd=config.REPO_ROOT,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        return out.stdout.strip() + ("-dirty" if dirty else "")
    except (OSError, subprocess.CalledProcessError):
        return None


def versions() -> dict[str, str]:
    out = {"python": platform.python_version()}
    for pkg in ("duckdb", "dbt-core", "dbt-duckdb", "openlineage-dbt", "sqlglot", "pyarrow"):
        try:
            out[pkg] = metadata.version(pkg)
        except metadata.PackageNotFoundError:
            out[pkg] = "missing"
    try:
        out["node"] = subprocess.run(
            ["node", "--version"], capture_output=True, text=True, check=True
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        out["node"] = "missing"
    return out


def slim(record: dict[str, Any]) -> dict[str, Any]:
    """Keep what tuning, LOSO and the report need; drop dataset-mode features and probe detail."""
    rec = dict(record)
    feats = rec.get("features")
    if feats:
        rec["features"] = {"column": feats.get("column", [])}
    rec.pop("top", None)
    rec.pop("promptText", None)
    rec.pop("summaryText", None)
    rec.pop("evidence", None)
    return rec


def pct(x: float) -> str:
    return f"{100 * x:.1f}%"


def interval(block: dict[str, Any], key: str) -> str:
    lo, hi = block[key]
    return f"{pct(lo)} to {pct(hi)}"


def markdown(report: dict[str, Any]) -> str:
    s = report["summary"]
    m = report["meta"]
    rc = s["rootCause"]["overAllInjected"]
    lines = [
        f"# DataTrust benchmark, {m['mode']} mode, {m['date']}",
        "",
        f"- Command: `{m['command']}`",
        f"- Git commit: `{m['gitCommit']}`",
        *(
            [
                f"- Trial records from `{m['sourceReport']}` (commit `{m['sourceGitCommit']}`, "
                f"{m['sourceDate']}); only the summary was recomputed here, no trial was rerun"
            ]
            if m.get("sourceReport")
            else []
        ),
        f"- Seeds: {', '.join(str(x) for x in m['seeds'])}; scenarios: {s['trials']['scenarios']}; "
        f"injected trials: {s['trials']['injected']}; clean trials: {s['trials']['clean']}",
        f"- Warehouse: {m['warehouse']}",
        f"- Weights: `{json.dumps(m['weights'])}`",
        f"- Wall time: {'not rerun' if m.get('sourceReport') else str(m['wallSeconds']) + ' s'}",
        "",
        "## Headline",
        "",
        "| Metric | Value | Wilson 95% | Scenario-clustered bootstrap 95% |",
        "|---|---|---|---|",
        f"| Detection recall (target 95%) | {pct(s['detectionRecall']['value'])} "
        f"({s['detectionRecall']['k']}/{s['detectionRecall']['n']}) | "
        f"{interval(s['detectionRecall'], 'wilson95')} | {interval(s['detectionRecall'], 'scenarioBootstrap95')} |",
        f"| Top-3 root-cause accuracy, all injected trials (target 90%) | {pct(rc['top3'])} "
        f"({rc['top3Interval']['k']}/{rc['top3Interval']['n']}) | {interval(rc['top3Interval'], 'wilson95')} | "
        f"{interval(rc['top3Interval'], 'scenarioBootstrap95')} |",
        f"| Top-1 root-cause accuracy, all injected trials | {pct(rc['top1'])} | "
        f"{interval(rc['top1Interval'], 'wilson95')} | {interval(rc['top1Interval'], 'scenarioBootstrap95')} |",
        "",
        f"- Clean false positives (failing checks over the clean trials): {s['cleanFalsePositives']}",
        f"- Over detected trials only: top-1 {pct(s['rootCause']['overDetected']['top1'])}, "
        f"top-3 {pct(s['rootCause']['overDetected']['top3'])}",
        f"- MRR (all injected): {rc['mrr']:.3f}; column-level top-3: {pct(s['rootCause']['columnTop3']['value'])} "
        f"over {s['rootCause']['columnTop3']['n']} trials with a column label",
        f"- Candidate-set size: median {s['candidateSetSize']['median']}, IQR {s['candidateSetSize']['q1']} to "
        f"{s['candidateSetSize']['q3']}",
        f"- Column-lineage coverage (share of model columns with a column edge): "
        f"{pct(s['lineageCoverage']['meanShare'])}",
        f"- Ranker top-3 gain over the best naive baseline ({s['bestBaseline']['name']}, "
        f"{pct(s['bestBaseline']['top3'])}): {s['top3GainOverBestBaselinePp']} percentage points",
    ]
    if s.get("loso"):
        lo = s["loso"]["pooled"]
        lines += [
            f"- Leave-one-scenario-out top-3: {pct(lo['top3'])} over {lo['n']} trials (weights re-tuned on dev "
            "seeds without the held-out scenario). The main result holds out seeds, values and severities but "
            "not defect types, because weights were tuned on dev seeds over the same 20 scenarios; LOSO is the "
            "closer estimate for unseen defect types.",
        ]
    lines += [
        "",
        "## Ablations and baselines (all injected trials)",
        "",
        "| Ranking | Top-1 | Top-3 | MRR |",
        "|---|---|---|---|",
    ]
    lines.append(f"| Full ranker | {pct(rc['top1'])} | {pct(rc['top3'])} | {rc['mrr']:.3f} |")
    for name, v in s["ablations"].items():
        lines.append(f"| ablation: {name} | {pct(v['top1'])} | {pct(v['top3'])} | {v['mrr']:.3f} |")
    for name, v in s["baselines"].items():
        if "top1" in v:
            lines.append(f"| baseline: {name} | {pct(v['top1'])} | {pct(v['top3'])} | {v['mrr']:.3f} |")
        else:
            lines.append(f"| baseline: {name} (expected) | n/a | {pct(v['top3'])} | n/a |")
    lines += ["", "## Per kind", "", "| Kind | Trials | Detection | Top-1 | Top-3 |", "|---|---|---|---|---|"]
    for kind, v in s["perKind"].items():
        lines.append(f"| {kind} | {v['n']} | {pct(v['detection'])} | {pct(v['top1'])} | {pct(v['top3'])} |")
    lines += [
        "",
        "## Per scenario",
        "",
        "| Scenario | Kind | Trials | Detected | Top-1 | Top-3 | Ground-truth rank per trial |",
        "|---|---|---|---|---|---|---|",
    ]
    for sid, v in s["perScenario"].items():
        ranks = ", ".join("miss" if r is None else str(r) for r in v["ranks"])
        lines.append(
            f"| {sid} {report['scenarioTitles'].get(sid, '')} | {v['kind']} | {v['n']} | {v['detected']} | "
            f"{v['top1']} | {v['top3']} | {ranks} |"
        )
    lines += metric_trigger_markdown(s.get("metricTrigger"), report.get("scenarioTitles") or {})
    lines.append("")
    return "\n".join(lines)


def metric_trigger_markdown(mt: dict[str, Any] | None, titles: dict[str, str]) -> list[str]:
    if not mt:
        return []
    oa = mt["overAlerted"]
    lines = [
        "",
        "## Metric-triggered trace (metric watch)",
        "",
        "Each trial's four metric tables are compared cell by cell with a clean, unpatched build of the same "
        "seed (the last green run). A metric with a moved cell has failed; the alert names the metric with the "
        "largest share of moved cells, as the runner does. The trial is then traced from that alert alone: "
        "its failing dbt checks are withheld, its passing checks kept, and the same probes and frozen-weight "
        "ranker run (`dbt-ol run` first builds the models dbt build skipped behind a failing test).",
        "",
        f"- Injected trials with a failed metric: {mt['withFailedMetric']}/{mt['injected']} "
        f"(Wilson 95% {pct(mt['withFailedMetricWilson95'][0])} to {pct(mt['withFailedMetricWilson95'][1])})",
        f"- Metric alerts on clean trials (false alarms): {mt['cleanFalseAlarms']}/{mt['clean']}",
    ]
    if oa["n"]:
        ti = oa["top3Interval"]
        lines += [
            f"- Traced from the failed metric alone, over those {oa['n']} trials: top-1 {pct(oa['top1'])}, "
            f"top-3 {pct(oa['top3'])} ({ti['k']}/{ti['n']}; Wilson 95% {interval(ti, 'wilson95')}; "
            f"scenario-clustered bootstrap 95% {interval(ti, 'scenarioBootstrap95')}), MRR {oa['mrr']:.3f}",
        ]
    lines.append(
        "- Alerted metrics: " + ", ".join(f"{k} {v}" for k, v in mt["alertMetrics"].items())
        if mt["alertMetrics"]
        else "- Alerted metrics: none"
    )
    lines += [
        "",
        "| Scenario | Trials | Metric alerts | Alerted metric | Top-1 | Top-3 | Ground-truth rank per trial |",
        "|---|---|---|---|---|---|---|",
    ]
    for sid, v in mt["perScenario"].items():
        ranks = ", ".join("miss" if r is None else str(r) for r in v["ranks"])
        lines.append(
            f"| {sid} {titles.get(sid, '')} | {v['n']} | {v['alerts']} | {', '.join(v['metrics']) or '-'} | "
            f"{v['top1']} | {v['top3']} | {ranks} |"
        )
    return lines


def write_report(
    records: list[dict[str, Any]],
    summary: dict[str, Any],
    *,
    out_dir: Path,
    mode: str,
    seeds: list[int],
    command: str,
    wall_seconds: float,
    weights: dict[str, float],
    tag: str | None = None,
    scenario_titles: dict[str, str] | None = None,
    date: str | None = None,
    extra_meta: dict[str, Any] | None = None,
) -> tuple[Path, Path]:
    date = date or dt.date.today().isoformat()
    name = f"bench-{date}-{mode}" + (f"-{tag}" if tag else "")
    report = {
        "meta": {
            "mode": mode,
            "date": date,
            "command": command,
            "gitCommit": git_commit(),
            "seeds": seeds,
            "wallSeconds": round(wall_seconds, 1),
            "warehouse": WAREHOUSE,
            "versions": versions(),
            "weights": weights,
            **(extra_meta or {}),
        },
        "summary": summary,
        "scenarioTitles": scenario_titles or {},
        "records": [slim(r) for r in records],
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    jpath = out_dir / f"{name}.json"
    jpath.write_text(json.dumps(report, indent=1, sort_keys=True, default=str) + "\n")
    mpath = out_dir / f"{name}.md"
    mpath.write_text(markdown(report))
    return jpath, mpath


def write_e2e_report(
    records: list[dict[str, Any]],
    *,
    out_dir: Path,
    seeds: list[int],
    command: str,
    wall_seconds: float,
    parity: list[dict[str, Any]] | None,
    tag: str | None = None,
    date: str | None = None,
) -> tuple[Path, Path]:
    date = date or dt.date.today().isoformat()
    name = f"bench-{date}-e2e" + (f"-{tag}" if tag else "")
    injected = [r for r in records if r["scenario"]]
    detected = sum(1 for r in injected if r["detected"])
    top3 = sum(1 for r in injected if r["groundTruth"] in r["ranked"][:3])
    top1 = sum(1 for r in injected if r["ranked"][:1] == [r["groundTruth"]])
    clean_fp = sum(len(r["failing"]) for r in records if not r["scenario"])
    summary = {
        "injectedTrials": len(injected),
        "detected": detected,
        "top1": top1,
        "top3": top3,
        "cleanFalsePositives": clean_fp,
        "parityChecked": parity is not None,
        "parityMismatches": parity,
    }
    report = {
        "meta": {
            "mode": "e2e",
            "date": date,
            "command": command,
            "gitCommit": git_commit(),
            "seeds": seeds,
            "wallSeconds": round(wall_seconds, 1),
            "warehouse": WAREHOUSE,
            "worker": "wrangler dev --local (Miniflare, workerd): local stand-in for Cloudflare Workers, Queues, Workflows, D1 and R2",
            "versions": versions(),
        },
        "summary": summary,
        "records": records,
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    jpath = out_dir / f"{name}.json"
    jpath.write_text(json.dumps(report, indent=1, sort_keys=True, default=str) + "\n")
    lines = [
        f"# DataTrust benchmark, e2e mode, {date}",
        "",
        f"- Command: `{command}`",
        f"- Git commit: `{report['meta']['gitCommit']}`",
        f"- Worker: {report['meta']['worker']}",
        f"- Warehouse: {WAREHOUSE}",
        f"- Wall time: {report['meta']['wallSeconds']} s",
        "",
        f"- Detected: {detected}/{len(injected)}; ground truth in top 3: {top3}/{len(injected)}; top 1: {top1}/{len(injected)}",
        f"- Clean false positives: {clean_fp}",
        "- Offline parity (identical top-3 lists): "
        + ("not checked" if parity is None else ("yes" if not parity else f"no, {len(parity)} mismatches")),
        "",
        "| Trial | Run status | Failing checks | Ground-truth rank | Summary provider | Seconds |",
        "|---|---|---|---|---|---|",
    ]
    for r in records:
        gt = r["groundTruth"]
        pos = (r["ranked"].index(gt) + 1) if gt and gt in r["ranked"] else ("n/a" if not gt else "miss")
        lines.append(
            f"| {r['trial']} | {r['status']} | {', '.join(r['failing']) or '-'} | {pos} | "
            f"{r['summaryProvider'] or '-'} | {r['wallSeconds']} |"
        )
    mpath = out_dir / f"{name}.md"
    mpath.write_text("\n".join(lines) + "\n")
    return jpath, mpath
