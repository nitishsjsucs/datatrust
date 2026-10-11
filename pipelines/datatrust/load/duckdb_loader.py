"""Load generated Parquet into the DuckDB warehouse (local stand-in for BigQuery) as `raw.*` sources."""

from __future__ import annotations

from pathlib import Path

import duckdb

from datatrust.synth import spec as S


def connect(path: Path, *, read_only: bool = False) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect(str(path), read_only=read_only)
    con.execute("set TimeZone = 'UTC'")  # ADR-0006
    return con


def load_raw(raw_dir: Path, duckdb_path: Path, tables: tuple[str, ...] = S.TABLE_ORDER) -> dict[str, int]:
    """Replace `raw.<table>` from `<raw_dir>/<table>.parquet`; returns loaded row counts."""
    duckdb_path.parent.mkdir(parents=True, exist_ok=True)
    counts: dict[str, int] = {}
    with connect(duckdb_path) as con:
        con.execute("create schema if not exists raw")
        for name in tables:
            path = raw_dir / f"{name}.parquet"
            if not path.exists():
                raise FileNotFoundError(path)
            con.execute(f'create or replace table raw."{name}" as select * from read_parquet(?)', [str(path)])
            row = con.execute(f'select count(*) from raw."{name}"').fetchone()
            counts[name] = int(row[0]) if row else 0
    return counts
