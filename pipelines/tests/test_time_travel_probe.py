"""delta_vs_last_green (SPEC 10): evidence-only row count now vs the last green run. The Worker sends only the
last green run id and finish time; the runner resolves a local Parquet snapshot or a clamped BigQuery
timestamp, then renders and runs the probe read-only."""

from __future__ import annotations

import duckdb

from datatrust.diagnostics.probes import ProbeRequest, render, run_probe
from datatrust.runner.loop import TIME_TRAVEL_WINDOW_MS, resolve_time_travel
from datatrust.warehouse.duckdb_wh import DuckDBWarehouse

NODE = "model.datatrust.fct_hires"
RELATIONS = {
    "project": "datatrust",
    "dialect": "duckdb",
    "nodes": {
        NODE: {
            "uniqueId": NODE,
            "kind": "model",
            "name": "fct_hires",
            "database": "datatrust-abc123",
            "schema": "marts",
            "identifier": "fct_hires",
            "materialization": "table",
            "columns": {},
            "meta": {},
        }
    },
}


def _req(run_id="run_01GREEN", finished=1_760_000_000_000):
    return ProbeRequest(
        "delta_vs_last_green:" + NODE + ":",
        "delta_vs_last_green",
        NODE,
        (),
        {"lastGreenRunId": run_id, "lastGreenFinishedAtMs": finished},
    )


def test_local_snapshot_is_resolved_and_the_probe_runs_read_only(tmp_path):
    db, snaps = tmp_path / "wh.duckdb", tmp_path / "snapshots"
    (snaps / "run_01GREEN").mkdir(parents=True)
    with duckdb.connect(str(db)) as con:
        con.execute("create schema marts")
        con.execute("create table marts.fct_hires as select range as hire_id from range(360)")
        con.execute(
            f"copy (select range as hire_id from range(350)) to '{snaps}/run_01GREEN/fct_hires.parquet' "
            "(format parquet)"
        )
    resolved = resolve_time_travel([_req(), _req("run_01MISSING")], "duckdb", RELATIONS, snaps, 0)
    assert [r.params for r in resolved] == [{"snapshot_path": f"{snaps}/run_01GREEN/fct_hires.parquet"}]
    with DuckDBWarehouse(db, snapshot_dir=snaps) as wh:
        result = run_probe(resolved[0], wh, RELATIONS)
    assert result.status == "ok"
    assert result.details == {"n_rows_now": 360, "n_rows_then": 350}
    assert result.anomaly == 0.0  # evidence only, never a ranking signal


def test_bigquery_timestamp_is_clamped_to_the_time_travel_window():
    now = 1_800_000_000_000
    old, recent = _req(finished=now - 30 * 24 * 3600 * 1000), _req(finished=now - 3600 * 1000)
    bq = {**RELATIONS, "dialect": "bigquery"}
    a, b = resolve_time_travel([old, recent], "bigquery", bq, None, now)
    assert a.params == {"as_of_ms": now - TIME_TRAVEL_WINDOW_MS + 3600 * 1000}
    assert b.params == {"as_of_ms": now - 3600 * 1000}
    sql = render(a, bq, "bigquery", lambda node: {"hire_id"})
    assert f"FOR SYSTEM_TIME AS OF TIMESTAMP_MILLIS({a.params['as_of_ms']})" in sql["historical"]
    assert "FOR SYSTEM_TIME" not in sql["main"]  # one point in time per table per statement


def test_unsafe_or_unknown_requests_are_dropped():
    bad = [
        _req(run_id="run_1; drop table x"),
        ProbeRequest("x", "delta_vs_last_green", "model.datatrust.nope", (), {}),
    ]
    assert resolve_time_travel(bad, "bigquery", RELATIONS, None, 0) == []
