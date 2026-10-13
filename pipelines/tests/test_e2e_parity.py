"""End-to-end mode through `wrangler dev --local` (Queues, both Workflows, the runner, the template
summarizer) ranks exactly like the offline benchmark (SPEC 12.2), and a failed metric on a green run starts
an alert investigation (SPEC 13.4). Needs the local Worker: run with `npm run bench:e2e -- --pytest` or, with
`npm run dev:up` already running, `uv run pytest -m e2e`.
"""

from __future__ import annotations

import os

import pytest

from datatrust.bench.e2e import _incident, drive, parity, run_e2e
from datatrust.bench.harness import run_bench, trial_specs

pytestmark = pytest.mark.e2e
SCENARIOS = ["S01", "T14", "S04"]


def _url() -> str:
    return os.environ.get("DATATRUST_API_URL", "http://127.0.0.1:8792")


@pytest.fixture(scope="module")
def e2e_records():
    return run_e2e([101], SCENARIOS, base_url=_url(), progress=False)


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


def test_a_failed_metric_on_a_green_run_is_investigated_from_the_metric(e2e_records):
    """The module's clean run is seed 101's last green run. One January cell of its metric_hires_monthly
    snapshot is raised by 2 (a restated month), so the next clean run's checks all pass but the runner's
    metric watch reports the metric with the build; the Worker ends the run failed and investigates it."""
    import duckdb

    from datatrust import config
    from datatrust.runner.client import Auth, WorkerClient

    clean = next(r for r in e2e_records if not r["scenario"])
    snap = config.snapshot_dir() / clean["runId"] / "metric_hires_monthly.parquet"
    assert snap.exists(), "the clean run left no snapshot"
    original = snap.read_bytes()
    operator = WorkerClient(_url(), Auth.local("operator"))
    runner = WorkerClient(_url(), Auth.local("runner"))
    try:
        with duckdb.connect() as con:
            con.execute(f"create table t as select * from read_parquet('{snap}')")
            con.execute(
                "update t set hires = hires + 2 where (department_id, hire_month) = "
                "(select (department_id, hire_month) from t order by hire_month, department_id limit 1)"
            )
            con.execute(f"copy t to '{snap}' (format parquet)")
        run_id = operator.create_run("duckdb", 101)
        out = drive(operator, runner, run_id)
    finally:
        snap.write_bytes(original)
    run = out["run"]
    assert run["status"] == "failed", run
    assert run["checkCounts"] == {"pass": 40, "fail": 0, "error": 0, "skip": 0}
    assert run["incidentId"].startswith(f"inc_{run_id}_alert_"), run
    assert not (config.snapshot_dir() / run_id).exists(), "a failed-metric run must not become a baseline"
    incident = _incident(operator, run["incidentId"], 300)
    assert incident["trigger"] == "alert"
    assert [c["checkId"] for c in incident["failingChecks"]] == ["alert:metric_hires_monthly"]
    assert incident["ranked"], incident
    assert {j["kind"] for j in out["jobs"]} == {"dbt_build", "diagnostics"}
