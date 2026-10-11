"""End-to-end mode through `wrangler dev --local` (Queues, both Workflows, the runner, the template
summarizer) ranks exactly like the offline benchmark (SPEC 12.2). Needs the local Worker: run with
`npm run bench:e2e` or, with `npm run dev:up` already running, `uv run pytest -m e2e`.
"""

from __future__ import annotations

import os

import pytest

from datatrust.bench.e2e import parity, run_e2e
from datatrust.bench.harness import run_bench, trial_specs

pytestmark = pytest.mark.e2e
SCENARIOS = ["S01", "T14", "S04"]


@pytest.fixture(scope="module")
def e2e_records():
    url = os.environ.get("DATATRUST_API_URL", "http://127.0.0.1:8792")
    return run_e2e([101], SCENARIOS, base_url=url, progress=False)


def test_incidents_exist_with_expected_fields(e2e_records):
    clean = [r for r in e2e_records if not r["scenario"]]
    assert [r["status"] for r in clean] == ["passed"]
    assert clean[0]["checkCounts"] == {"pass": 40, "fail": 0, "error": 0, "skip": 0}
    for r in [r for r in e2e_records if r["scenario"]]:
        assert r["status"] == "failed", r
        assert r["incidentId"] and r["incidentId"].startswith(f"inc_{r['runId']}_checks_")
        assert r["groundTruth"] in r["ranked"][:3], r
        assert r["summaryProvider"] == "template"
        assert r["diagnosticSqlCount"] > 0
        assert r["provenance"]["warehouse"] == "duckdb (local stand-in for BigQuery)"
        assert {j["kind"] for j in r["jobs"]} == {"dbt_build", "diagnostics"}


def test_parity_with_offline_mode(e2e_records, tmp_path):
    offline = run_bench(
        trial_specs([101], SCENARIOS, clean=False), work_dir=tmp_path, workers=3, progress=False
    )
    assert parity(e2e_records, offline) == []
