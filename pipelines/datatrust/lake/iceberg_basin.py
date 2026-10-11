"""Basin Catalog (formerly R2 Data Catalog) through pyiceberg's REST catalog: the production catalog for
`datatrust lake commit --catalog basin` and the smoke's read-back (SPEC 13.9, 18.4, 28.5.1). Needs
BASIN_CATALOG_URI, BASIN_WAREHOUSE and BASIN_CATALOG_TOKEN (an R2 API token)."""

from __future__ import annotations

import os

import pyarrow as pa
from pyiceberg.catalog.rest import RestCatalog
from pyiceberg.expressions import EqualTo, In

NAMESPACE = "datatrust"
TABLE = "audit_events"


def catalog() -> RestCatalog:
    missing = [
        k for k in ("BASIN_CATALOG_URI", "BASIN_WAREHOUSE", "BASIN_CATALOG_TOKEN") if not os.environ.get(k)
    ]
    if missing:
        raise RuntimeError(f"missing {', '.join(missing)} (see README, production setup)")
    return RestCatalog(
        name="datatrust_basin",
        warehouse=os.environ["BASIN_WAREHOUSE"],
        uri=os.environ["BASIN_CATALOG_URI"],
        token=os.environ["BASIN_CATALOG_TOKEN"],
    )


def list_namespaces() -> list[tuple[str, ...]]:
    return catalog().list_namespaces()


def run_completed_events(run_ids: list[str]) -> pa.Table:
    t = catalog().load_table(f"{NAMESPACE}.{TABLE}")
    return t.scan(row_filter=In("run_id", run_ids) & EqualTo("event_type", "run_completed")).to_arrow()
