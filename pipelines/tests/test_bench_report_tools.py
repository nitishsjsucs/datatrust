"""`datatrust report` (re-summarize a committed report for a seed subset) and `datatrust compare` (two reports
trial by trial): the held-out figure and the recheck claim in the README come from these commands."""

from __future__ import annotations

import json
import subprocess
import sys

from datatrust import config

REPORT = config.REPO_ROOT / "results" / "bench-2026-10-10-offline.json"


def _datatrust(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "datatrust.cli", *args], capture_output=True, text=True, cwd=config.REPO_ROOT
    )


def test_report_resummarizes_a_seed_subset_without_rerunning(tmp_path):
    res = _datatrust(
        "report",
        "--from",
        str(REPORT),
        "--seeds",
        "102-105",
        "--tag",
        "t",
        "--out",
        str(tmp_path),
        "--date",
        "2026-01-01",
    )
    assert res.returncode == 0, res.stderr
    out = json.loads((tmp_path / "bench-2026-01-01-offline-t.json").read_text())
    s = out["summary"]
    assert (s["detectionRecall"]["k"], s["detectionRecall"]["n"]) == (80, 80)
    top = s["rootCause"]["overAllInjected"]
    assert (top["top3Interval"]["k"], top["top3Interval"]["n"]) == (80, 80) and top["top1"] == 0.9
    assert out["meta"]["sourceReport"] == REPORT.name and out["meta"]["seeds"] == [102, 103, 104, 105]
    assert "no trial was rerun" in (tmp_path / "bench-2026-01-01-offline-t.md").read_text()
    assert (
        _datatrust(
            "report", "--from", str(REPORT), "--seeds", "7", "--tag", "x", "--out", str(tmp_path)
        ).returncode
        == 2
    )


def test_compare_finds_equal_and_different_reports(tmp_path):
    same = _datatrust("compare", str(REPORT), str(REPORT))
    assert same.returncode == 0 and json.loads(same.stdout)["trials"] == 105
    data = json.loads(REPORT.read_text())
    data["records"][0]["ranked"] = list(reversed(data["records"][0]["ranked"]))
    changed = tmp_path / "changed.json"
    changed.write_text(json.dumps(data))
    diff = _datatrust("compare", str(REPORT), str(changed))
    assert diff.returncode == 1
    assert json.loads(diff.stdout)["differences"] == [f"trial {data['records'][0]['trial']}: ranked differs"]
