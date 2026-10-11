"""The probe SQL guard accepts one read-only query and nothing else (SPEC 10, ADR-0007)."""

from __future__ import annotations

import duckdb
import pytest

from datatrust.warehouse.duckdb_wh import DuckDBWarehouse
from datatrust.warehouse.readonly import ReadOnlyViolation, assert_read_only

ALLOWED = [
    "select 1",
    "with a as (select 1 as x) select x from a",
    "select * from t union all select * from u",
    "select count(*) from `p.d.t` FOR SYSTEM_TIME AS OF TIMESTAMP_MILLIS(1)",
]
BLOCKED = [
    "drop table t",
    "select 1; select 2",
    "insert into t values (1)",
    "update t set x = 1",
    "delete from t",
    "create table x as select 1",
    "copy t to 'out.csv'",
    "attach 'other.duckdb'",
    "set threads = 1",
    "pragma version",
    "install httpfs",
    "select * from read_csv('/etc/passwd')",
    "select * from read_parquet('/etc/x.parquet')",
    "select * from read_parquet('/snap/../etc/x.parquet')",
]


@pytest.mark.parametrize("sql", ALLOWED)
def test_allowed(sql):
    assert_read_only(sql, "bigquery" if "`" in sql else "duckdb")


@pytest.mark.parametrize("sql", BLOCKED)
def test_blocked(sql):
    with pytest.raises(ReadOnlyViolation):
        assert_read_only(sql, "duckdb", allowed_parquet_prefix="/snap/")


def test_snapshot_parquet_allowed_only_under_prefix():
    assert_read_only(
        "select count(*) from read_parquet('/snap/r1/fct.parquet')", "duckdb", allowed_parquet_prefix="/snap/"
    )


def test_connection_is_read_only_even_if_the_guard_is_bypassed(tmp_path):
    path = tmp_path / "w.duckdb"
    with duckdb.connect(str(path)) as con:
        con.execute("create table t as select 1 as x")
    wh = DuckDBWarehouse(path)
    try:
        assert wh.query("select x from t") == [{"x": 1}]
        with pytest.raises(duckdb.Error):
            wh._con.execute("insert into t values (2)")  # bypass the guard on purpose
    finally:
        wh.close()
