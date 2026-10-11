from __future__ import annotations

import functools
from dataclasses import dataclass
from pathlib import Path

import pytest

from datatrust.synth.generator import Dataset, generate, write_dataset


@functools.lru_cache(maxsize=8)
def _cached(seed: int) -> Dataset:
    return generate(seed)


@pytest.fixture(scope="session")
def dataset_factory():
    """Generated datasets are deterministic, so they are shared across tests (read-only)."""
    return _cached


@dataclass
class BuiltWarehouse:
    seed: int
    duckdb_path: Path
    target_path: Path
    returncode: int
    output: str

    def connect(self):
        from datatrust.load.duckdb_loader import connect

        return connect(self.duckdb_path, read_only=True)


def build_warehouse(seed: int, root: Path, dbt_args: list[str] | None = None) -> BuiltWarehouse:
    from datatrust.dbt.build import run_dbt
    from datatrust.load.duckdb_loader import load_raw

    raw = root / "raw"
    write_dataset(_cached(seed), raw)
    db = root / "warehouse.duckdb"
    load_raw(raw, db)
    res = run_dbt(dbt_args or ["build"], target_path=root / "target", duckdb_path=db)
    return BuiltWarehouse(seed, db, root / "target", res.returncode, res.stdout)


@pytest.fixture(scope="session")
def built_101(tmp_path_factory) -> BuiltWarehouse:
    """Seed 101, clean, full `dbt build` on a fresh DuckDB file."""
    return build_warehouse(101, tmp_path_factory.mktemp("wh101"))
