"""Local Iceberg stand-in (pyiceberg SqlCatalog on SQLite) for the Basin Catalog lake (SPEC 13.9)."""

from __future__ import annotations

import json
import os

import pyarrow as pa

from datatrust.lake import iceberg_local
from datatrust.lake.schema import arrow_schema, stream_fields, to_arrow


def _event(i: int, event_type: str = "check_result") -> dict:
    return {
        "event_id": f"evt_{i}",
        "event_type": event_type,
        "environment": "local",
        "run_id": "run_1",
        "occurred_at": f"2026-10-10T17:00:0{i}.000Z",
        "check_id": "U01" if event_type == "check_result" else None,
        "status": "pass",
        "node": "model.datatrust.stg_employees",
        "payload": {"failures": 0, "columns": ["employee_id"]},
    }


def test_schema_follows_the_stream_definition():
    names = [f["name"] for f in stream_fields()]
    assert names == arrow_schema().names
    assert arrow_schema().field("occurred_at").type == pa.timestamp("us", tz="UTC")
    assert arrow_schema().field("payload").type == pa.string()


def test_append_read_and_time_travel(tmp_path):
    root = tmp_path / "lake"
    assert iceberg_local.append(to_arrow([_event(1), _event(2)]), root) == 2
    first_snapshot = iceberg_local.table(root).current_snapshot().snapshot_id
    iceberg_local.append(to_arrow([_event(3, "run_completed")]), root)
    rows = sorted(iceberg_local.read(root).to_pylist(), key=lambda r: r["event_id"])
    assert len(rows) == 3
    assert json.loads(rows[0]["payload"]) == {"columns": ["employee_id"], "failures": 0}
    assert rows[0]["occurred_at"].isoformat() == "2026-10-10T17:00:01+00:00"
    assert iceberg_local.read(root, snapshot_id=first_snapshot).num_rows == 2


def test_catalog_is_usable_from_another_directory(tmp_path):
    root = tmp_path / "lake"
    iceberg_local.append(to_arrow([_event(1)]), root)
    cwd = os.getcwd()
    try:
        os.chdir(tmp_path.parent)
        assert iceberg_local.read(root).num_rows == 1
        metadata = iceberg_local.table(root).metadata_location
        assert metadata.startswith("file://") and str(root.resolve()) in metadata
    finally:
        os.chdir(cwd)
