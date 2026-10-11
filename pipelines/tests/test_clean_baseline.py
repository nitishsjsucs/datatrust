"""Clean seed 101: 29 models build, 40 checks pass, 0 fail, 0 error (SPEC 7.1, 8).

CI runs this file twice, under TZ=UTC and TZ=America/Los_Angeles (ADR-0006).
"""

from __future__ import annotations

from collections import Counter

from datatrust.checks.results import classify, summarize


def test_build_returncode(built_101):
    assert built_101.returncode == 0, built_101.output[-4000:]


def test_forty_checks_pass(built_101, built_101_results):
    results = built_101_results
    data_tests = [r for r in results if r.kind == "data_test"]
    assert len(data_tests) == 40
    assert summarize(results) == {"pass": 40, "fail": 0, "error": 0, "skip": 0}
    assert not [r for r in results if r.kind != "data_test"]


def test_all_models_succeed(built_101):
    import json

    rr = json.loads((built_101.target_path / "run_results.json").read_text())
    statuses = Counter(r["status"] for r in rr["results"] if r["unique_id"].startswith("model."))
    assert statuses == {"success": 29}


def test_clean_invariants(built_101):
    with built_101.connect() as con:
        q = lambda sql: con.execute(sql).fetchone()  # noqa: E731
        assert q("select count(*), count(base_salary_usd) from staging.int_compensation_usd") == (1980, 1980)
        assert q("select count(*), count(base_salary_usd) from marts.fct_compensation_usd") == (1200, 1200)
        assert q("select count(*), count(distinct employee_id) from marts.fct_compensation_usd") == (
            1200,
            1200,
        )
        assert q("select count(*) from marts.fct_payroll_reconciliation") == (12060,)
        assert q("select sum(hires) from marts.metric_hires_monthly") == (360,)
        assert q("select count(*) from marts.dim_employee") == (1200,)


def test_classifier_on_clean_run(built_101):
    import json

    rr = json.loads((built_101.target_path / "run_results.json").read_text())
    manifest = json.loads((built_101.target_path / "manifest.json").read_text())
    ids = sorted(r.checkId for r in classify(rr, manifest))
    assert len(ids) == 40 and len(set(ids)) == 40
