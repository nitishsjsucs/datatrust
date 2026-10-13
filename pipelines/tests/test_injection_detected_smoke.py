"""Three scenarios end to end through dbt, offline: injected, detected, traced and ranked (SPEC 12); S01 and
the clean trial also through the metric watch (a failed metric traced on its own, no alert when clean)."""

from __future__ import annotations

import pytest

from datatrust.bench.harness import TrialSpec, baseline_checksums, metric_baseline, run_trial


@pytest.fixture(scope="module")
def baseline(tmp_path_factory):
    return baseline_checksums(tmp_path_factory.mktemp("baseline"))


@pytest.fixture(scope="module")
def metric_dir(tmp_path_factory):
    return metric_baseline(101, tmp_path_factory.mktemp("metric-baseline"))


@pytest.mark.parametrize("scenario", ["S01", "T14", "S04"])
def test_trial_detects_and_ranks(scenario, baseline, tmp_path):
    rec = run_trial(TrialSpec(101, scenario), tmp_path, baseline)
    assert rec["detected"], rec["failing"]
    assert rec["groundTruth"] in rec["ranked"], rec["ranked"]
    assert rec["probeStatus"]["error"] == 0
    assert rec["candidateCount"] == len(rec["ranked"])
    for name in ("coverage_only", "dataset_lineage_only", "no_probes", "no_change_signal"):
        assert rec["ablations"][name]


def test_clean_trial_has_no_failures(baseline, metric_dir, tmp_path):
    rec = run_trial(TrialSpec(101, None), tmp_path, baseline, metric_dir=metric_dir)
    assert rec["failing"] == []
    assert rec["checkCounts"] == {"pass": 40, "fail": 0, "error": 0, "skip": 0}
    assert rec["metricWatch"] == {"watched": 4, "failed": [], "alert": None}


def test_a_failed_metric_is_traced_on_its_own_to_the_root_cause(baseline, metric_dir, tmp_path):
    rec = run_trial(TrialSpec(101, "S01"), tmp_path, baseline, metric_dir=metric_dir)
    mw = rec["metricWatch"]
    assert mw["watched"] == 4
    assert mw["alert"]["metricNode"] == "model.datatrust.metric_hires_monthly"
    assert mw["alert"]["column"] == "hires"
    assert rec["groundTruth"] in mw["ranked"][:3], mw["ranked"]
    assert mw["probeStatus"]["error"] == 0
