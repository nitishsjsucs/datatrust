"""BigQuery branches of the dialect macros: rendered, free of DuckDB-only constructs, parseable (SPEC 7.3).

`dbt parse --target bigquery` and sqlglot both accept some SQL that BigQuery rejects, so this test does not
claim BigQuery validity. It renders every bigquery__ branch under the DuckDB target and fails on constructs
BigQuery is known to reject. Real validation is `datatrust prod validate` (SPEC 18.1).
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
import sqlglot

from datatrust.dbt.build import run_dbt

DBT_DIR = Path(__file__).resolve().parents[2] / "dbt"

BANNED_IN_BIGQUERY = [
    (r"::", "postgres-style cast"),
    (r"median\s*\(", "median() is DuckDB-only"),
    (r"\blist\s*\(", "list() is DuckDB-only"),
    (r"\brange\s*\(", "range() is DuckDB-only"),
    (r"\btimezone\s*\(", "timezone() is DuckDB-only"),
    (r"//", "integer division operator"),
    (r"decimal\s*\(", "decimal(p,s) type"),
    (r"timestamptz", "timestamptz type"),
    (r"date_diff\s*\(\s*'", "DuckDB date_diff argument order"),
    (r"date_trunc\s*\(\s*'", "DuckDB date_trunc argument order"),
    (
        r"percentile_(cont|disc)\s*\([^)]*\)\s*over\s*\([^)]*(order\s+by|rows|range)",
        "percentile window frame",
    ),
]


def render(dialect: str, tmp_path: Path) -> dict[str, str]:
    res = run_dbt(
        ["run-operation", "print_dialect_macros", "--args", f"{{dialect: {dialect}}}"],
        target_path=tmp_path / f"target-{dialect}",
        duckdb_path=tmp_path / "render.duckdb",
    )
    assert res.returncode == 0, res.stdout
    line = next(ln for ln in res.stdout.splitlines() if ln.startswith("DIALECT_MACROS_JSON="))
    return json.loads(line.split("=", 1)[1])


@pytest.fixture(scope="module")
def rendered(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("dialect")
    return {"bigquery": render("bigquery", tmp), "duckdb": render("duckdb", tmp)}


def banned_hits(sql: str) -> list[str]:
    return [why for pattern, why in BANNED_IN_BIGQUERY if re.search(pattern, sql, re.I)]


def test_both_dialects_render_the_same_macros(rendered):
    assert set(rendered["bigquery"]) == set(rendered["duckdb"])
    assert len(rendered["bigquery"]) >= 18


def test_bigquery_branches_have_no_banned_constructs(rendered):
    hits = {name: banned_hits(sql) for name, sql in rendered["bigquery"].items()}
    assert {k: v for k, v in hits.items() if v} == {}


def test_the_check_catches_known_invalid_bigquery(rendered):
    # The guard must fail on the DuckDB branches, otherwise it proves nothing.
    flagged = {name for name, sql in rendered["duckdb"].items() if banned_hits(sql)}
    assert {"tz_local_date", "tz_local_hour", "date_spine", "int_div", "trailing_median"} <= flagged
    bad = "percentile_cont(x, 0.5) over (partition by g order by d rows between 29 preceding and current row)"
    assert banned_hits(bad)


def _statement(name: str, sql: str) -> str:
    if name == "date_spine":
        return f"select d from {sql} as s"
    if name == "time_travel":
        return f"select count(*) from {sql}"
    if name == "trailing_median_finish":
        return f"select {sql} as m from t"
    return f"select {sql} as v from t"


@pytest.mark.parametrize("dialect", ["bigquery", "duckdb"])
def test_sqlglot_parses_rendered_branches(rendered, dialect):
    for name, sql in rendered[dialect].items():
        sqlglot.parse_one(_statement(name, sql), read=dialect)


def test_models_and_tests_use_only_portable_sql():
    """Model and singular-test SQL must route dialect differences through macros."""
    offenders = {}
    for folder in ("models", "tests"):
        for path in DBT_DIR.joinpath(folder).rglob("*.sql"):
            text = re.sub(r"\{#.*?#\}", "", path.read_text(), flags=re.S)
            text = re.sub(r"\{\{.*?\}\}", "", text, flags=re.S)
            text = re.sub(r"--[^\n]*", "", text)
            hits = banned_hits(text)
            if hits:
                offenders[str(path.relative_to(DBT_DIR))] = hits
    assert offenders == {}
