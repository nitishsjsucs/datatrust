"""Warehouse protocol used by the probes (SPEC 10)."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Literal, Protocol

Dialect = Literal["duckdb", "bigquery"]


class Warehouse(Protocol):
    dialect: Dialect

    def query(
        self, sql: str, params: Mapping[str, object] | None = None, *, max_rows: int = 1000
    ) -> list[dict]: ...

    def close(self) -> None: ...
