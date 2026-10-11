"""DuckDB warehouse for probes: a separate read-only connection pinned to UTC (ADR-0006, ADR-0007)."""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import Any

import duckdb

from datatrust.warehouse.readonly import assert_read_only


class DuckDBWarehouse:
    dialect = "duckdb"

    def __init__(self, path: Path, *, snapshot_dir: Path | None = None) -> None:
        self.path = Path(path)
        self.snapshot_dir = Path(snapshot_dir) if snapshot_dir else None
        self._con = duckdb.connect(str(self.path), read_only=True)
        self._con.execute("set TimeZone = 'UTC'")
        self._columns: dict[tuple[str, str], set[str]] = {}

    def relation_columns(self, node: Mapping[str, Any]) -> set[str]:
        """Columns of a relation from the information schema; empty if the relation does not exist."""
        key = (str(node["schema"]), str(node["identifier"]))
        if key not in self._columns:
            rows = self.query(
                "select column_name from information_schema.columns "
                "where table_schema = $schema and table_name = $name",
                {"schema": key[0], "name": key[1]},
                max_rows=10_000,
            )
            self._columns[key] = {r["column_name"] for r in rows}
        return self._columns[key]

    def query(
        self, sql: str, params: Mapping[str, object] | None = None, *, max_rows: int = 1000
    ) -> list[dict]:
        prefix = str(self.snapshot_dir) + "/" if self.snapshot_dir else None
        assert_read_only(sql, "duckdb", allowed_parquet_prefix=prefix)
        cur = self._con.execute(sql, dict(params) if params else None)
        cols = [d[0] for d in cur.description or []]
        return [dict(zip(cols, row, strict=True)) for row in cur.fetchmany(max_rows)]

    def close(self) -> None:
        self._con.close()

    def __enter__(self) -> DuckDBWarehouse:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()
