"""Arrow schema derived from schemas/lake/audit_event.stream.json (the Basin Pipelines stream)."""

from __future__ import annotations

import datetime as dt
import json
from functools import lru_cache
from typing import Any

import pyarrow as pa

from datatrust import config

STREAM_SCHEMA = config.REPO_ROOT / "schemas" / "lake" / "audit_event.stream.json"


@lru_cache(maxsize=1)
def stream_fields() -> list[dict[str, Any]]:
    return json.loads(STREAM_SCHEMA.read_text())["fields"]


def arrow_schema() -> pa.Schema:
    types = {"string": pa.string(), "timestamp": pa.timestamp("us", tz="UTC"), "json": pa.string()}
    return pa.schema(
        [pa.field(f["name"], types[f["type"]], nullable=not f["required"]) for f in stream_fields()]
    )


def to_arrow(events: list[dict[str, Any]]) -> pa.Table:
    """Events as an Arrow table. `json` fields are stored as serialized strings (SPEC 13.9)."""
    cols: dict[str, list[Any]] = {f["name"]: [] for f in stream_fields()}
    for e in events:
        for f in stream_fields():
            v = e.get(f["name"])
            if f["type"] == "timestamp" and v is not None:
                v = dt.datetime.fromisoformat(str(v).replace("Z", "+00:00")).astimezone(dt.UTC)
            elif f["type"] == "json" and v is not None:
                v = json.dumps(v, sort_keys=True)
            cols[f["name"]].append(v)
    return pa.Table.from_pydict(cols, schema=arrow_schema())
