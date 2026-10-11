"""Every planned probe renders for DuckDB and BigQuery, passes the read-only guard and parses (SPEC 10)."""

from __future__ import annotations

import copy

import pytest
import sqlglot

from datatrust.diagnostics.probes import PROBES, ProbeError, ProbeRequest, render, render_expression
from datatrust.warehouse.duckdb_wh import DuckDBWarehouse
from datatrust.warehouse.readonly import assert_read_only


@pytest.fixture(scope="module")
def columns_of(built_101):
    wh = DuckDBWarehouse(built_101.duckdb_path)
    yield lambda node: wh.relation_columns({"schema": node["schema"], "identifier": node["identifier"]})
    wh.close()


def test_planner_covers_every_ranking_probe(all_planned_probes):
    _, probes = all_planned_probes
    kinds = {p["probe"] for p in probes}
    assert kinds == set(PROBES) - {"delta_vs_last_green"}


@pytest.mark.parametrize("dialect", ["duckdb", "bigquery"])
def test_every_planned_probe_renders_and_parses(all_planned_probes, columns_of, dialect):
    rel, probes = all_planned_probes
    rel = copy.deepcopy(rel)
    if dialect == "bigquery":
        for n in rel["nodes"].values():
            n["database"] = "datatrust-ci-placeholder"
    assert len(probes) > 100
    for p in probes:
        sections = render(ProbeRequest.from_json(p), rel, dialect, columns_of)
        for sql in sections.values():
            assert_read_only(sql, dialect)
            sqlglot.parse_one(sql, read=dialect)
            if dialect == "bigquery":
                for banned in ("timezone(", "median(", "range(", "//", "try_cast", "decimal("):
                    assert banned not in sql.lower(), (p["probeId"], banned)


def test_unknown_columns_and_nodes_are_rejected(all_planned_probes, columns_of):
    rel, _ = all_planned_probes
    bad = [
        ProbeRequest("x", "null_rate", "model.datatrust.dim_employee", ("no_such_column",)),
        ProbeRequest("x", "null_rate", "model.datatrust.dim_employee", ("employee_id; drop table x",)),
        ProbeRequest("x", "null_rate", "model.datatrust.not_a_model", ("employee_id",)),
        ProbeRequest("x", "not_a_probe", "model.datatrust.dim_employee", ("employee_id",)),
        ProbeRequest(
            "x",
            "recompute_delta",
            "model.datatrust.fct_compensation_usd",
            ("base_salary_usd",),
            {"expr": "base_salary_local * (select 1)"},
        ),
    ]
    for req in bad:
        with pytest.raises(ProbeError):
            render(req, rel, "duckdb", columns_of)


def test_expression_language():
    cols = {"entered_at", "location_tz", "base_salary_local_minor", "a", "b"}
    assert render_expression("tz_local_date(entered_at, location_tz)", cols, "bigquery") == (
        "DATE(entered_at, location_tz)"
    )
    assert render_expression("int_div(base_salary_local_minor + 6, 12)", cols, "duckdb") == (
        "((base_salary_local_minor + 6) // (12))"
    )
    assert render_expression("a * b", cols, "duckdb") == "a * b"
    with pytest.raises(ProbeError):
        render_expression("a; drop table b", cols, "duckdb")
