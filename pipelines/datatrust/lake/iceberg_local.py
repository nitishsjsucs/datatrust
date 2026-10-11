"""Local stand-in for Basin Catalog: a pyiceberg SqlCatalog on SQLite (SPEC 13.9). `datatrust lake commit
--catalog local` (lake/commit.py) writes it; `append` here is for tests and `read` for `lake query`.

The warehouse is an absolute file:// URI: a relative path also works but records cwd-relative metadata
locations, which break when the command runs from another directory (verified).
"""

from __future__ import annotations

from pathlib import Path

import pyarrow as pa
from pyiceberg.catalog.sql import SqlCatalog
from pyiceberg.table import Table

from datatrust import config


def lake_dir() -> Path:
    return config.DATA_DIR / "lake"


def catalog(root: Path | None = None) -> SqlCatalog:
    root = (root or lake_dir()).resolve()
    (root / "warehouse").mkdir(parents=True, exist_ok=True)
    return SqlCatalog(
        "datatrust_local",
        uri=f"sqlite:///{root / 'catalog.db'}",
        warehouse=(root / "warehouse").as_uri(),
    )


def table(root: Path | None = None) -> Table:
    from datatrust.lake.commit import ensure_table

    return ensure_table(catalog(root))


def append(rows: pa.Table, root: Path | None = None) -> int:
    if rows.num_rows == 0:
        return 0
    t = table(root)
    t.append(rows)
    return rows.num_rows


def read(root: Path | None = None, snapshot_id: int | None = None) -> pa.Table:
    return table(root).scan(snapshot_id=snapshot_id).to_arrow()
