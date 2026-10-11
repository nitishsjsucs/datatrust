"""Paths and environment for the runner (SPEC section 14.4)."""

from __future__ import annotations

import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DBT_DIR = REPO_ROOT / "dbt"
DATA_DIR = Path(os.environ.get("DATATRUST_DATA_DIR", REPO_ROOT / ".data")).resolve()
RESULTS_DIR = REPO_ROOT / "results"


def raw_dir(seed: int) -> Path:
    return DATA_DIR / "raw" / str(seed)


def duckdb_path() -> Path:
    return Path(os.environ.get("DATATRUST_DUCKDB_PATH", DATA_DIR / "warehouse.duckdb")).resolve()


def snapshot_dir() -> Path:
    return Path(os.environ.get("DATATRUST_SNAPSHOT_DIR", DATA_DIR / "snapshots")).resolve()
