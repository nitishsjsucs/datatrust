"""Local stand-in for Basin Catalog: a pyiceberg SqlCatalog on SQLite (SPEC 13.9).

The warehouse is an absolute file:// URI: a relative path also works but records cwd-relative metadata
locations, which break when the command runs from another directory (verified).
"""

from __future__ import annotations

from pathlib import Path

import pyarrow as pa
from pyiceberg.catalog.sql import SqlCatalog
from pyiceberg.exceptions import NamespaceAlreadyExistsError, NoSuchTableError
from pyiceberg.table import Table

from datatrust import config
from datatrust.lake.schema import arrow_schema

NAMESPACE = "datatrust"
TABLE = "audit_events"


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
    cat = catalog(root)
    try:
        cat.create_namespace(NAMESPACE)
    except NamespaceAlreadyExistsError:
        pass
    try:
        return cat.load_table(f"{NAMESPACE}.{TABLE}")
    except NoSuchTableError:
        return cat.create_table(f"{NAMESPACE}.{TABLE}", schema=arrow_schema())


def append(rows: pa.Table, root: Path | None = None) -> int:
    if rows.num_rows == 0:
        return 0
    t = table(root)
    t.append(rows)
    return rows.num_rows


def read(root: Path | None = None, snapshot_id: int | None = None) -> pa.Table:
    return table(root).scan(snapshot_id=snapshot_id).to_arrow()
