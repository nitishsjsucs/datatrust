"""sqlglot guard: a probe must be exactly one read-only SELECT (SPEC 10, ADR-0007).

This is one layer of three: probes also run on a read-only DuckDB connection locally and as the
read-only `datatrust-prober` service account on BigQuery, so a guard bypass still cannot write.
"""

from __future__ import annotations

import sqlglot
from sqlglot import exp

_FORBIDDEN = (
    exp.Insert,
    exp.Update,
    exp.Delete,
    exp.Merge,
    exp.Create,
    exp.Drop,
    exp.Alter,
    exp.Command,
    exp.Copy,
    exp.Set,
    exp.Use,
    exp.Pragma,
    exp.TruncateTable,
    exp.Transaction,
    exp.Commit,
    exp.Rollback,
)
# Table functions that read files or URLs. read_parquet is allowed only under the snapshot directory.
_FILE_FUNCTIONS = {
    "read_csv",
    "read_csv_auto",
    "read_json",
    "read_json_auto",
    "read_ndjson",
    "read_text",
    "read_blob",
    "glob",
    "sniff_csv",
    "parquet_scan",
    "read_parquet",
    "query_table",
    "iceberg_scan",
    "delta_scan",
}


class ReadOnlyViolation(ValueError):
    pass


def _function_name(node: exp.Expression) -> str:
    if isinstance(node, exp.Anonymous):
        return str(node.name).lower()
    return node.sql_name().lower() if hasattr(node, "sql_name") else type(node).__name__.lower()


def assert_read_only(sql: str, dialect: str, *, allowed_parquet_prefix: str | None = None) -> None:
    try:
        statements = [s for s in sqlglot.parse(sql, read=dialect) if s is not None]
    except sqlglot.errors.ParseError as err:
        raise ReadOnlyViolation(f"unparseable SQL: {err}") from err
    if len(statements) != 1:
        raise ReadOnlyViolation(f"expected exactly one statement, got {len(statements)}")
    stmt = statements[0]
    if not isinstance(stmt, exp.Query):
        raise ReadOnlyViolation(f"not a query: {type(stmt).__name__}")
    for node in stmt.walk():
        if isinstance(node, _FORBIDDEN):
            raise ReadOnlyViolation(f"forbidden construct: {type(node).__name__}")
        if isinstance(node, exp.Func):
            name = _function_name(node)
            if name in _FILE_FUNCTIONS or isinstance(node, exp.ReadCSV):
                if name in ("read_parquet", "parquet_scan") and allowed_parquet_prefix:
                    literal = node.find(exp.Literal)
                    path = literal.this if literal is not None else ""
                    if isinstance(path, str) and path.startswith(allowed_parquet_prefix) and ".." not in path:
                        continue
                raise ReadOnlyViolation(f"file access function not allowed: {name}")
