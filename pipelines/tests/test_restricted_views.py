"""The restricted compensation report exposes department aggregates only (SPEC 7.4, 19): no PII or
per-person columns, groups under 5 employees suppressed, and it reads only the untagged aggregate table.
On DuckDB it is a plain view (stand-in); on BigQuery it is an authorized view, which
`datatrust prod governance verify` checks."""

from __future__ import annotations

import json

PERSONAL = {"pii", "identifier", "compensation"}


def _manifest(built):
    return json.loads((built.target_path / "manifest.json").read_text())


def test_reads_only_the_untagged_aggregate(built_101):
    m = _manifest(built_101)
    rpt = m["nodes"]["model.datatrust.rpt_compensation_by_dept"]
    assert rpt["config"]["materialized"] == "view"
    assert rpt["schema"] == "restricted"
    assert rpt["depends_on"]["nodes"] == ["model.datatrust.int_comp_by_dept_month"]
    agg = m["nodes"]["model.datatrust.int_comp_by_dept_month"]
    assert not any(c.get("policy_tags") for c in agg["columns"].values())


def test_no_personal_columns(built_101):
    m = _manifest(built_101)
    for name in ("rpt_compensation_by_dept", "int_comp_by_dept_month"):
        cols = m["nodes"][f"model.datatrust.{name}"]["columns"]
        assert {c["meta"]["classification"] for c in cols.values()} & PERSONAL == set(), name
        assert not {"employee_id", "first_name", "last_name", "work_email", "base_salary_local"} & set(cols)
    with built_101.connect() as con:
        actual = {
            r[0]
            for r in con.execute(
                "select column_name from information_schema.columns "
                "where table_schema = 'restricted' and table_name = 'rpt_compensation_by_dept'"
            ).fetchall()
        }
    expected = {"department_id", "month_start", "headcount", "total_base_salary_usd", "avg_base_salary_usd"}
    assert actual == expected


def test_small_groups_are_suppressed(built_101):
    with built_101.connect() as con:
        n, smallest, nulls = con.execute(
            "select count(*), min(headcount), count(*) - count(total_base_salary_usd) "
            "from restricted.rpt_compensation_by_dept"
        ).fetchone()
        groups = con.execute(
            "select count(*) filter (where n >= 5), count(*) filter (where n < 5) from ("
            "select department_id, month_start, count(distinct employee_id) n "
            "from staging.int_employee_month where is_active group by 1, 2)"
        ).fetchone()
    assert n > 0 and smallest >= 5 and nulls == 0
    # exactly the department-months with at least 5 active employees are reported, the rest suppressed
    assert n == groups[0]
