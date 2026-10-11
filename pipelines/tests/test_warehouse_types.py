"""ADR-0006: money and rates are DECIMAL(38,9), instants TIMESTAMPTZ, minor units BIGINT (SPEC 7.2)."""

from __future__ import annotations

import re
from pathlib import Path

import yaml

MONEY_COLUMNS = {
    ("staging", "stg_compensation", "base_salary_local"),
    ("staging", "stg_payroll_lines", "gross_pay_local"),
    ("staging", "stg_fx_rates", "rate_to_usd"),
    ("staging", "int_compensation_usd", "base_salary_usd"),
    ("marts", "fct_compensation_usd", "base_salary_local"),
    ("marts", "fct_compensation_usd", "base_salary_usd"),
    ("marts", "fct_compensation_usd", "rate_to_usd"),
    ("marts", "fct_payroll_reconciliation", "expected_gross_local"),
    ("marts", "fct_payroll_reconciliation", "actual_gross_local"),
    ("marts", "fct_payroll_reconciliation", "actual_gross_usd"),
    ("marts", "fct_payroll_reconciliation", "delta_pct"),
    ("marts", "metric_payroll_cost_usd_monthly", "payroll_cost_usd"),
    ("restricted", "rpt_compensation_by_dept", "total_base_salary_usd"),
}
MINOR_COLUMNS = {
    ("staging", "stg_compensation", "base_salary_local_minor"),
    ("staging", "stg_payroll_lines", "gross_pay_local_minor"),
    ("marts", "fct_payroll_reconciliation", "expected_gross_local_minor"),
    ("marts", "fct_payroll_reconciliation", "actual_gross_local_minor"),
}

DBT_DIR = Path(__file__).resolve().parents[2] / "dbt"

# Contract data_type strings must mirror macros/dialect/types.sql (dt_type) for both adapters.
ALLOWED_CONTRACT_TYPES = {
    "{{ 'int64' if target.type == 'bigquery' else 'bigint' }}",
    "{{ 'string' if target.type == 'bigquery' else 'varchar' }}",
    "date",
    "{{ 'timestamp' if target.type == 'bigquery' else 'timestamptz' }}",
    "{{ 'numeric' if target.type == 'bigquery' else 'decimal(38,9)' }}",
    "{{ 'bool' if target.type == 'bigquery' else 'boolean' }}",
    "{{ 'float64' if target.type == 'bigquery' else 'double' }}",
}


def _columns(con, schema):
    return {
        (s, t, c): dtype
        for s, t, c, dtype in con.execute(
            "select table_schema, table_name, column_name, data_type from information_schema.columns "
            "where table_schema = ?",
            [schema],
        ).fetchall()
    }


def test_build_succeeded(built_101):
    assert built_101.returncode == 0, built_101.output[-4000:]


def test_money_rate_and_instant_types(built_101):
    with built_101.connect() as con:
        cols = {}
        for schema in ("staging", "marts", "restricted"):
            cols.update(_columns(con, schema))
    assert {s for s, _, _ in cols} == {"staging", "marts", "restricted"}
    for key in MONEY_COLUMNS:
        assert cols[key] == "DECIMAL(38,9)", key
    for key in MINOR_COLUMNS:
        assert cols[key] == "BIGINT", key
    instants = {k: v for k, v in cols.items() if k[2].endswith("_at")}
    assert instants and set(instants.values()) == {"TIMESTAMP WITH TIME ZONE"}
    assert not [k for k, v in cols.items() if v.startswith("DECIMAL") and v != "DECIMAL(38,9)"]
    assert "DOUBLE" not in {v for k, v in cols.items() if k in MONEY_COLUMNS}


def test_contract_types_mirror_dt_type():
    seen = 0
    for path in DBT_DIR.joinpath("models").rglob("*.yml"):
        doc = yaml.safe_load(path.read_text()) or {}
        for model in doc.get("models", []):
            for col in model.get("columns", []):
                if "data_type" in col:
                    seen += 1
                    assert col["data_type"] in ALLOWED_CONTRACT_TYPES, (path.name, model["name"], col)
    assert seen > 0
    types_sql = DBT_DIR.joinpath("macros/dialect/types.sql").read_text()

    def mapping(macro: str) -> dict[str, str]:
        block = types_sql.split(f"macro {macro}(kind)")[1].split("endmacro")[0]
        return dict(re.findall(r"'(\w+)': '([a-z0-9(),]+)'", block))

    duck, bq = mapping("duckdb__dt_type"), mapping("bigquery__dt_type")
    pairs = {(bq[k], duck[k]) for k in duck}
    for expr in ALLOWED_CONTRACT_TYPES:
        m = re.fullmatch(r"\{\{ '(.+)' if target.type == 'bigquery' else '(.+)' \}\}", expr)
        pair = (m.group(1), m.group(2)) if m else (expr, expr)
        assert pair in pairs, expr
