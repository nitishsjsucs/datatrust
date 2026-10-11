"""Benchmark statistics (SPEC 12.3)."""

from __future__ import annotations

import pytest

from datatrust.bench.metrics import cluster_bootstrap, gt_rank, summarize, wilson


def test_wilson_known_values():
    lo, hi = wilson(95, 100)
    assert lo == pytest.approx(0.8882, abs=1e-4)
    assert hi == pytest.approx(0.9785, abs=1e-4)
    assert wilson(0, 0) == (0.0, 0.0)
    lo, hi = wilson(20, 20)
    assert hi == 1.0 and lo == pytest.approx(0.8389, abs=1e-4)


def test_cluster_bootstrap_is_deterministic_and_respects_clusters():
    clusters = {f"S{i:02d}": [1.0] * 5 for i in range(19)} | {"S19": [0.0] * 5}
    a = cluster_bootstrap(clusters, reps=2000)
    assert a == cluster_bootstrap(clusters, reps=2000)
    assert a[0] < 0.95 < a[1] or a[1] == 1.0
    assert cluster_bootstrap({"A": [1.0], "B": [1.0]}, reps=100) == (1.0, 1.0)


def test_gt_rank():
    assert gt_rank(["a", "b", "c"], "b") == 2
    assert gt_rank(["a"], "z") is None
    assert gt_rank(None, "a") is None


def _rec(scenario, detected, ranked, gt="g", kind="source"):
    return {
        "trial": f"t-{scenario}",
        "scenario": scenario,
        "kind": kind,
        "groundTruth": gt,
        "groundTruthColumn": None,
        "detected": detected,
        "failing": ["X"] if detected else [],
        "ranked": ranked,
        "candidateCount": len(ranked),
        "features": {"column": [{"node": n} for n in ranked]},
        "ablations": {
            k: ranked for k in ("coverage_only", "dataset_lineage_only", "no_probes", "no_change_signal")
        },
        "baselines": {"change_only": list(reversed(ranked)), "nearest_upstream_source": []},
        "lineageCoverage": {"share": 0.9},
    }


def test_summarize_counts_undetected_as_misses():
    recs = [
        _rec("S01", True, ["g", "a"]),
        _rec("S02", True, ["a", "b", "c", "g"]),
        _rec("S03", False, []),
        {
            "trial": "clean",
            "scenario": None,
            "kind": "clean",
            "groundTruth": None,
            "detected": False,
            "failing": [],
        },
    ]
    s = summarize(recs)
    assert s["trials"] == {"injected": 3, "clean": 1, "scenarios": 3}
    assert s["detectionRecall"]["value"] == pytest.approx(2 / 3)
    assert s["cleanFalsePositives"] == 0
    rc = s["rootCause"]
    assert rc["overAllInjected"]["top3"] == pytest.approx(1 / 3)
    assert rc["overDetected"]["top3"] == pytest.approx(1 / 2)
    assert rc["overAllInjected"]["mrr"] == pytest.approx((1 + 0.25) / 3)
    assert s["baselines"]["random_in_closure"]["top3"] == pytest.approx((1 + 0.75 + 0) / 3)
    assert s["perScenario"]["S02"]["ranks"] == [4]
