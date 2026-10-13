"""Metric watch (SPEC 13.1): a metric whose closed history moved since the last green run has failed; the
runner reports the most-changed one as an alert on a green build and keeps that run out of the baseline."""

from __future__ import annotations

import duckdb
import pytest

from datatrust.checks.metric_watch import (
    META_FILE,
    choose_alert,
    compare_metrics,
    failed_metrics,
    last_green_snapshot,
    metric_specs,
)
from datatrust.runner.loop import after_green_build

HEADCOUNT = "model.datatrust.metric_headcount_monthly"
HIRES = "model.datatrust.metric_hires_monthly"


def _node(uid: str, name: str, grain: list[str], metric: str) -> dict:
    return {
        "uniqueId": uid,
        "kind": "model",
        "name": name,
        "schema": "marts",
        "identifier": name,
        "materialization": "table",
        "columns": {},
        "meta": {"grain": grain, "metric": metric},
    }


RELATIONS = {
    "project": "datatrust",
    "dialect": "duckdb",
    "nodes": {
        HEADCOUNT: _node(
            HEADCOUNT, "metric_headcount_monthly", ["department_id", "month_start"], "headcount"
        ),
        HIRES: _node(HIRES, "metric_hires_monthly", ["department_id", "hire_month"], "hires"),
        "model.datatrust.fct_hires": {
            **_node("model.datatrust.fct_hires", "fct_hires", [], ""),
            "meta": {"grain": ["hire_id"]},
        },
    },
}

HEADCOUNT_ROWS = "(1, date '2025-01-01', 10), (1, date '2025-02-01', 11), (2, date '2025-01-01', 4)"
HIRES_ROWS = "(1, date '2025-01-01', 2), (2, date '2025-01-01', 1)"


def _warehouse(path, headcount_rows=HEADCOUNT_ROWS, hires_rows=HIRES_ROWS):
    with duckdb.connect(str(path)) as con:
        con.execute("create schema if not exists marts")
        con.execute(
            "create or replace table marts.metric_headcount_monthly "
            "(department_id bigint, month_start date, headcount bigint)"
        )
        con.execute(f"insert into marts.metric_headcount_monthly values {headcount_rows}")
        con.execute(
            "create or replace table marts.metric_hires_monthly "
            "(department_id bigint, hire_month date, hires bigint)"
        )
        con.execute(f"insert into marts.metric_hires_monthly values {hires_rows}")


def _snapshot(db, out):
    out.mkdir(parents=True, exist_ok=True)
    with duckdb.connect(str(db)) as con:
        for name in ("metric_headcount_monthly", "metric_hires_monthly"):
            con.execute(f"copy (select * from marts.{name}) to '{out}/{name}.parquet' (format parquet)")


def test_metric_specs_come_from_model_meta():
    specs = metric_specs(RELATIONS)
    assert [(s.node, s.grain, s.column) for s in specs] == [
        (HEADCOUNT, ("department_id", "month_start"), "headcount"),
        (HIRES, ("department_id", "hire_month"), "hires"),
    ]


def test_unchanged_history_has_no_failed_metric(tmp_path):
    db = tmp_path / "wh.duckdb"
    _warehouse(db)
    _snapshot(db, tmp_path / "green")
    changes = compare_metrics(db, RELATIONS, tmp_path / "green")
    assert [(c.node, c.cells, c.changed) for c in changes] == [(HEADCOUNT, 3, 0), (HIRES, 2, 0)]
    assert failed_metrics(changes) == []
    assert choose_alert(changes) is None


def test_moved_missing_and_duplicated_cells_fail_and_the_largest_share_is_reported(tmp_path):
    green, db = tmp_path / "green.duckdb", tmp_path / "now.duckdb"
    _warehouse(green)
    _snapshot(green, tmp_path / "green")
    # headcount: one value moved (11 -> 14) and one department-month disappeared: 2 of 3 cells.
    # hires: a duplicated grain row (fan-out) for department 2: 1 of 2 cells.
    _warehouse(
        db,
        headcount_rows="(1, date '2025-01-01', 10), (1, date '2025-02-01', 14)",
        hires_rows="(1, date '2025-01-01', 2), (2, date '2025-01-01', 1), (2, date '2025-01-01', 1)",
    )
    changes = {c.node: c for c in compare_metrics(db, RELATIONS, tmp_path / "green")}
    assert (changes[HEADCOUNT].cells, changes[HEADCOUNT].changed) == (3, 2)
    assert (changes[HIRES].cells, changes[HIRES].changed) == (2, 1)
    # The cell that moved most: department 2's January vanished (4 -> 0) beats 11 -> 14.
    assert choose_alert(list(changes.values())) == {
        "metricNode": HEADCOUNT,
        "column": "headcount",
        "observed": 0.0,
        "expected": 4.0,
    }


def test_ties_break_by_node_id():
    from datatrust.checks.metric_watch import MetricChange

    a = MetricChange(HIRES, "hires", 10, 1, 1.0, 2.0)
    b = MetricChange(HEADCOUNT, "headcount", 10, 1, 5.0, 4.0)
    assert choose_alert([a, b])["metricNode"] == HEADCOUNT


def test_a_metric_without_a_snapshot_or_table_is_not_compared(tmp_path):
    db = tmp_path / "wh.duckdb"
    _warehouse(db)
    (tmp_path / "green").mkdir()
    assert compare_metrics(db, RELATIONS, tmp_path / "green") == []


def test_the_comparison_runs_through_the_read_only_guard(tmp_path, monkeypatch):
    import datatrust.warehouse.duckdb_wh as wh

    seen = []
    real = wh.assert_read_only

    def spy(sql, dialect, **kw):
        seen.append(kw.get("allowed_parquet_prefix"))
        return real(sql, dialect, **kw)

    monkeypatch.setattr(wh, "assert_read_only", spy)
    db = tmp_path / "wh.duckdb"
    _warehouse(db)
    _snapshot(db, tmp_path / "green")
    compare_metrics(db, RELATIONS, tmp_path / "green")
    assert seen and all(p == str((tmp_path / "green").resolve()) + "/" for p in seen)


def test_last_green_snapshot_matches_seed_and_target_and_takes_the_newest(tmp_path):
    root = tmp_path / "snapshots"
    for run, seed, target, at in [
        ("run_A", 101, "duckdb", 1.0),
        ("run_B", 101, "duckdb", 3.0),
        ("run_C", 7, "duckdb", 9.0),
        ("run_D", 101, "bigquery", 9.0),
    ]:
        (root / run).mkdir(parents=True)
        (root / run / META_FILE).write_text(f'{{"seed": {seed}, "target": "{target}", "finishedAt": {at}}}')
    (root / "run_OLD").mkdir()  # a snapshot from before the watch: no metadata, never a baseline
    assert last_green_snapshot(root, seed=101) == root / "run_B"
    assert last_green_snapshot(root, seed=42) is None
    assert last_green_snapshot(tmp_path / "absent", seed=101) is None


@pytest.fixture
def runner_relations():
    # Only the two metric tables exist in the test warehouse; the runner snapshots every mart table.
    return {**RELATIONS, "nodes": {k: v for k, v in RELATIONS["nodes"].items() if k in (HEADCOUNT, HIRES)}}


def test_runner_snapshots_a_green_run_then_reports_a_moved_metric_without_snapshotting_it(
    tmp_path, runner_relations
):
    root, db = tmp_path / "snapshots", tmp_path / "wh.duckdb"
    _warehouse(db)
    # First green run of seed 101: no earlier snapshot, so nothing to compare; it becomes the baseline.
    assert after_green_build(db, runner_relations, root, "run_01", seed=101) is None
    assert (root / "run_01" / "metric_hires_monthly.parquet").exists()
    meta = (root / "run_01" / META_FILE).read_text()
    assert '"seed": 101' in meta and '"target": "duckdb"' in meta
    # Same data again: still green, snapshotted.
    assert after_green_build(db, runner_relations, root, "run_02", seed=101) is None
    # History restated: the alert comes back and the run leaves no snapshot behind.
    _warehouse(db, hires_rows="(1, date '2025-01-01', 3), (2, date '2025-01-01', 1)")
    alert = after_green_build(db, runner_relations, root, "run_03", seed=101)
    assert alert == {"metricNode": HIRES, "column": "hires", "observed": 3.0, "expected": 2.0}
    assert not (root / "run_03").exists()
    # Another seed has no baseline yet: no alert.
    assert after_green_build(db, runner_relations, root, "run_04", seed=7) is None
