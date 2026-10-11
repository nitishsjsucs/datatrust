"""Three scenarios end to end through dbt, offline: injected, detected, traced and ranked (SPEC 12)."""

from __future__ import annotations

import pytest

from datatrust.bench.harness import TrialSpec, baseline_checksums, run_trial


@pytest.fixture(scope="module")
def baseline(tmp_path_factory):
    return baseline_checksums(tmp_path_factory.mktemp("baseline"))


@pytest.mark.parametrize("scenario", ["S01", "T14", "S04"])
def test_trial_detects_and_ranks(scenario, baseline, tmp_path):
    rec = run_trial(TrialSpec(101, scenario), tmp_path, baseline)
    assert rec["detected"], rec["failing"]
    assert rec["groundTruth"] in rec["ranked"], rec["ranked"]
    assert rec["probeStatus"]["error"] == 0
    assert rec["candidateCount"] == len(rec["ranked"])
    for name in ("coverage_only", "dataset_lineage_only", "no_probes", "no_change_signal"):
        assert rec["ablations"][name]


def test_clean_trial_has_no_failures(baseline, tmp_path):
    rec = run_trial(TrialSpec(101, None), tmp_path, baseline)
    assert rec["failing"] == []
    assert rec["checkCounts"] == {"pass": 40, "fail": 0, "error": 0, "skip": 0}
