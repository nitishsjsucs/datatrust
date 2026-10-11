"""The restricted compensation report exposes department aggregates only (SPEC 7.4, 19): no PII or
per-person columns, groups under 5 employees suppressed, and it reads only the untagged aggregate table.
On DuckDB it is a plain view (stand-in); on BigQuery it is an authorized view, which
`datatrust prod governance verify` checks."""

from __future__ import annotations

import json
import re

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


# Analyst-readable schemas: datatrust_marts (marts and metrics) and datatrust_restricted (governance.py).
ANALYST_SCHEMAS = {"marts", "restricted"}
K_SUPPRESSION = re.compile(r"having\s+count\(\s*distinct\s+employee_id\s*\)\s*>=\s*5", re.IGNORECASE)


def _compensation_taint(target_path):
    """Columns derived from compensation through the build's OpenLineage column lineage. Taint starts at every
    column classified `compensation` (tagged or masked upstream) and flows downstream, except out of a model
    with k >= 5 suppression (`having count(distinct employee_id) >= 5`), whose groups are safe to show."""
    m = json.loads((target_path / "manifest.json").read_text())
    nodes = {
        uid: n
        for uid, n in {**m["nodes"], **m["sources"]}.items()
        if n["resource_type"] in ("model", "source")
    }
    by_relation = {
        f"{n['schema']}.{n.get('alias') or n.get('identifier') or n['name']}".lower(): uid
        for uid, n in nodes.items()
    }

    def node_of(dataset: str) -> str | None:
        return by_relation.get(".".join(dataset.lower().split(".")[-2:]))

    parents: dict[tuple[str, str], set[tuple[str, str]]] = {}
    for line in (target_path / "openlineage.jsonl").read_text().splitlines():
        event = json.loads(line) if line.strip() else {}
        if event.get("eventType") != "COMPLETE":
            continue
        for out in event.get("outputs", []):
            dst = node_of(out["name"])
            fields = ((out.get("facets") or {}).get("columnLineage") or {}).get("fields") or {}
            for col, f in fields.items():
                for i in f.get("inputFields", []):
                    src = node_of(i["name"])
                    if dst and src:
                        parents.setdefault((dst, col), set()).add((src, i["field"]))

    def classification(uid: str, col: str) -> str | None:
        c = nodes[uid]["columns"].get(col) or {}
        return (c.get("meta") or {}).get("classification") or (c.get("config", {}).get("meta") or {}).get(
            "classification"
        )

    memo: dict[tuple[str, str], bool] = {}

    def tainted(key: tuple[str, str]) -> bool:
        if key not in memo:
            uid, col = key
            memo[key] = False  # cycles cannot occur in a dbt DAG; this only guards the recursion
            raw = nodes[uid].get("raw_code") or ""
            memo[key] = classification(uid, col) == "compensation" or (
                not K_SUPPRESSION.search(raw) and any(tainted(p) for p in parents.get(key, ()))
            )
        return memo[key]

    return nodes, parents, tainted


def test_no_analyst_readable_column_exposes_unsuppressed_compensation(built_101):
    """Every compensation-derived column the masked analyst can read carries the compensation policy tag
    (ALWAYS_NULL masking) unless k >= 5 suppression sits on its lineage (2026-10-11 review: the payroll cost
    metric had neither, so a department-month with 1 to 4 people paid would have exposed their pay)."""
    nodes, parents, tainted = _compensation_taint(built_101.target_path)
    assert len(parents) > 100  # the column lineage was read
    exposed, checked = [], 0
    for uid, n in nodes.items():
        if n["resource_type"] != "model" or n["schema"] not in ANALYST_SCHEMAS:
            continue
        for col, c in n["columns"].items():
            if tainted((uid, col)):
                checked += 1
                if not c.get("policy_tags"):
                    exposed.append(f"{n['name']}.{col}")
    assert exposed == []
    assert checked >= 10
    # The cases this guards, and the suppressed aggregate that stays readable.
    assert tainted(("model.datatrust.metric_payroll_cost_usd_monthly", "payroll_cost_usd"))
    assert tainted(("model.datatrust.fct_payroll_reconciliation", "delta_pct"))
    assert not tainted(("model.datatrust.rpt_compensation_by_dept", "total_base_salary_usd"))
