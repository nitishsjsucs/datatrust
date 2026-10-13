"""Benchmark metrics (SPEC 12.3): detection recall, clean false positives, top-1/top-3 root-cause accuracy,
MRR, column-level top-3, Wilson and scenario-clustered bootstrap intervals, ablations, naive baselines,
candidate-set size and lineage coverage.
"""

from __future__ import annotations

import math
import random
import statistics
from collections import defaultdict
from collections.abc import Callable, Sequence
from typing import Any

Z95 = 1.959963984540054
BOOTSTRAP_REPS = 10_000
BOOTSTRAP_SEED = 20261010


def wilson(k: int, n: int, z: float = Z95) -> tuple[float, float]:
    """Wilson score interval for a binomial proportion."""
    if n == 0:
        return (0.0, 0.0)
    p = k / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return (max(0.0, centre - half), min(1.0, centre + half))


def cluster_bootstrap(
    clusters: dict[str, Sequence[float]], reps: int = BOOTSTRAP_REPS, seed: int = BOOTSTRAP_SEED
) -> tuple[float, float]:
    """95% percentile interval of the pooled mean, resampling whole clusters (scenarios) with replacement.

    The 100 test trials are 20 scenarios repeated over 5 seeds, not 100 independent draws, so each
    scenario's trials stay together.
    """
    keys = sorted(clusters)
    if not keys:
        return (0.0, 0.0)
    r = random.Random(seed)
    stats = []
    for _ in range(reps):
        total = 0.0
        count = 0
        for _ in keys:
            vals = clusters[keys[int(r.random() * len(keys))]]
            total += sum(vals)
            count += len(vals)
        stats.append(total / count if count else 0.0)
    stats.sort()
    lo = stats[int(math.floor(0.025 * reps))]
    hi = stats[min(reps - 1, int(math.ceil(0.975 * reps)) - 1)]
    return (lo, hi)


def gt_rank(order: Sequence[str] | None, gt: str | None) -> int | None:
    if not order or gt is None or gt not in order:
        return None
    return list(order).index(gt) + 1


def _rate(hits: Sequence[float]) -> float:
    return sum(hits) / len(hits) if hits else 0.0


def _interval_block(hits_by_scenario: dict[str, list[float]]) -> dict[str, Any]:
    flat = [h for hs in hits_by_scenario.values() for h in hs]
    k = int(round(sum(flat)))
    n = len(flat)
    return {
        "value": _rate(flat),
        "k": k,
        "n": n,
        "wilson95": list(wilson(k, n)),
        "scenarioBootstrap95": list(cluster_bootstrap(hits_by_scenario)),
    }


def _topk_from(records: list[dict[str, Any]], order_of: Callable[[dict[str, Any]], Sequence[str] | None]):
    top1, top3, rr = [], [], []
    for rec in records:
        pos = gt_rank(order_of(rec), rec["groundTruth"])
        top1.append(1.0 if pos == 1 else 0.0)
        top3.append(1.0 if pos is not None and pos <= 3 else 0.0)
        rr.append(1.0 / pos if pos else 0.0)
    return {"top1": _rate(top1), "top3": _rate(top3), "mrr": _rate(rr), "n": len(records)}


def summarize(records: list[dict[str, Any]], loso: dict[str, Any] | None = None) -> dict[str, Any]:
    injected = [r for r in records if r["scenario"]]
    clean = [r for r in records if not r["scenario"]]
    detected = [r for r in injected if r["detected"]]

    by_scen_detect: dict[str, list[float]] = defaultdict(list)
    by_scen_top3: dict[str, list[float]] = defaultdict(list)
    by_scen_top1: dict[str, list[float]] = defaultdict(list)
    for r in injected:
        pos = gt_rank(r.get("ranked"), r["groundTruth"])
        by_scen_detect[r["scenario"]].append(1.0 if r["detected"] else 0.0)
        by_scen_top3[r["scenario"]].append(1.0 if pos is not None and pos <= 3 else 0.0)
        by_scen_top1[r["scenario"]].append(1.0 if pos == 1 else 0.0)

    def ranked(rec):
        return rec.get("ranked")

    over_all = _topk_from(injected, ranked)
    over_detected = _topk_from(detected, ranked)

    col_hits = []
    for r in injected:
        if not r.get("groundTruthColumn"):
            continue
        pos = gt_rank(r.get("ranked"), r["groundTruth"])
        cols = (r.get("rankedColumns") or {}).get(r["groundTruth"], [])
        col_hits.append(1.0 if pos is not None and pos <= 3 and r["groundTruthColumn"] in cols else 0.0)

    ablations = {}
    for name in ("coverage_only", "dataset_lineage_only", "no_probes", "no_change_signal"):
        ablations[name] = _topk_from(injected, lambda rec, n=name: (rec.get("ablations") or {}).get(n))
    baselines = {
        "change_only": _topk_from(injected, lambda rec: (rec.get("baselines") or {}).get("change_only")),
        "nearest_upstream_source": _topk_from(
            injected, lambda rec: (rec.get("baselines") or {}).get("nearest_upstream_source")
        ),
    }
    rand_top3 = []
    for r in injected:
        rows = (r.get("features") or {}).get("column") or []
        nodes = {row["node"] for row in rows}
        rand_top3.append(min(1.0, 3 / len(nodes)) if r["groundTruth"] in nodes else 0.0)
    baselines["random_in_closure"] = {"top3": _rate(rand_top3), "n": len(rand_top3)}
    best_baseline = max(baselines.items(), key=lambda kv: kv[1]["top3"])

    sizes = [r["candidateCount"] for r in detected if "candidateCount" in r]
    q = statistics.quantiles(sizes, n=4) if len(sizes) >= 2 else [float(sizes[0])] * 3 if sizes else [0, 0, 0]
    coverage = [r["lineageCoverage"]["share"] for r in detected if r.get("lineageCoverage")]

    per_scenario = {}
    for sid in sorted(by_scen_detect):
        recs = [r for r in injected if r["scenario"] == sid]
        ranks = [gt_rank(r.get("ranked"), r["groundTruth"]) for r in recs]
        per_scenario[sid] = {
            "kind": recs[0]["kind"],
            "n": len(recs),
            "detected": sum(1 for r in recs if r["detected"]),
            "top1": sum(1 for p in ranks if p == 1),
            "top3": sum(1 for p in ranks if p is not None and p <= 3),
            "ranks": ranks,
        }
    per_kind = {}
    for kind in ("source", "transformation"):
        recs = [r for r in injected if r["kind"] == kind]
        per_kind[kind] = {
            "n": len(recs),
            "detection": _rate([1.0 if r["detected"] else 0.0 for r in recs]),
            **{k: v for k, v in _topk_from(recs, ranked).items() if k != "n"},
        }

    return {
        "trials": {"injected": len(injected), "clean": len(clean), "scenarios": len(by_scen_detect)},
        "detectionRecall": _interval_block(by_scen_detect),
        "cleanFalsePositives": sum(len(r["failing"]) for r in clean),
        "rootCause": {
            "overAllInjected": {
                **over_all,
                "top3Interval": _interval_block(by_scen_top3),
                "top1Interval": _interval_block(by_scen_top1),
            },
            "overDetected": over_detected,
            "columnTop3": {"value": _rate(col_hits), "n": len(col_hits)},
        },
        "ablations": ablations,
        "baselines": baselines,
        "bestBaseline": {"name": best_baseline[0], "top3": best_baseline[1]["top3"]},
        "top3GainOverBestBaselinePp": round(100 * (over_all["top3"] - best_baseline[1]["top3"]), 1),
        "candidateSetSize": {
            "median": statistics.median(sizes) if sizes else 0,
            "q1": q[0],
            "q3": q[2],
        },
        "lineageCoverage": {"meanShare": _rate(coverage)},
        "perScenario": per_scenario,
        "perKind": per_kind,
        "loso": loso,
        **({"metricTrigger": mt} if (mt := metric_trigger(records)) else {}),
    }


def metric_trigger(records: list[dict[str, Any]]) -> dict[str, Any] | None:
    """The metric watch (harness docstring): how often a trial moved a metric against the clean build, and
    where the ground truth ranked when traced from that failed metric alone. None for reports without it."""
    watched = [r for r in records if "metricWatch" in r]
    if not watched:
        return None
    injected = [r for r in watched if r["scenario"]]
    clean = [r for r in watched if not r["scenario"]]
    alerted = [r for r in injected if r["metricWatch"].get("alert")]

    def order(rec: dict[str, Any]) -> Sequence[str] | None:
        return rec["metricWatch"].get("ranked")

    by_scen_top3: dict[str, list[float]] = defaultdict(list)
    for r in alerted:
        pos = gt_rank(order(r), r["groundTruth"])
        by_scen_top3[r["scenario"]].append(1.0 if pos is not None and pos <= 3 else 0.0)
    per_scenario = {}
    for sid in sorted({r["scenario"] for r in injected}):
        recs = [r for r in injected if r["scenario"] == sid]
        ranks = [gt_rank(order(r), r["groundTruth"]) if r["metricWatch"].get("alert") else None for r in recs]
        per_scenario[sid] = {
            "n": len(recs),
            "alerts": sum(1 for r in recs if r["metricWatch"].get("alert")),
            "metrics": sorted(
                {
                    r["metricWatch"]["alert"]["metricNode"].split(".")[-1]
                    for r in recs
                    if r["metricWatch"].get("alert")
                }
            ),
            "top1": sum(1 for p in ranks if p == 1),
            "top3": sum(1 for p in ranks if p is not None and p <= 3),
            "ranks": [
                p if r["metricWatch"].get("alert") else "no alert" for r, p in zip(recs, ranks, strict=True)
            ],
        }
    metrics_alerted: dict[str, int] = defaultdict(int)
    for r in alerted:
        metrics_alerted[r["metricWatch"]["alert"]["metricNode"].split(".")[-1]] += 1
    return {
        "injected": len(injected),
        "clean": len(clean),
        "withFailedMetric": len(alerted),
        "withFailedMetricWilson95": list(wilson(len(alerted), len(injected))),
        "cleanFalseAlarms": sum(1 for r in clean if r["metricWatch"].get("alert")),
        "overAlerted": {
            **_topk_from(alerted, order),
            "top3Interval": _interval_block(by_scen_top3) if alerted else None,
        },
        "alertMetrics": dict(sorted(metrics_alerted.items())),
        "perScenario": per_scenario,
    }


def baseline_from(summary: dict[str, Any]) -> dict[str, Any]:
    """The few numbers a CI gate compares against."""
    rc = summary["rootCause"]["overAllInjected"]
    return {
        "detectionRecall": summary["detectionRecall"]["value"],
        "top1": rc["top1"],
        "top3": rc["top3"],
        "cleanFalsePositives": summary["cleanFalsePositives"],
        "injectedTrials": summary["trials"]["injected"],
        "cleanTrials": summary["trials"]["clean"],
    }


def gate(summary: dict[str, Any], baseline: dict[str, Any], tolerance: float = 0.05) -> list[str]:
    """CI gate (SPEC 20): no clean false positives; detection and top-3 within `tolerance` of the baseline."""
    now = baseline_from(summary)
    problems = []
    if now["cleanFalsePositives"] != 0:
        problems.append(f"clean false positives: {now['cleanFalsePositives']}")
    alarms = (summary.get("metricTrigger") or {}).get("cleanFalseAlarms", 0)
    if alarms:
        problems.append(f"metric watch false alarms on clean trials: {alarms}")
    for key in ("detectionRecall", "top3"):
        if now[key] < baseline[key] - tolerance:
            problems.append(
                f"{key} {now[key]:.3f} is more than {tolerance} below the baseline {baseline[key]:.3f}"
            )
    return problems
