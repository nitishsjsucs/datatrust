"""`datatrust lake sync`: pull NDJSON audit events from the local Worker (/api/dev/lake-export) and append
them to the local Iceberg table (SPEC 13.9). The cursor lives next to the catalog."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from datatrust.lake.iceberg_local import append, lake_dir
from datatrust.lake.schema import to_arrow
from datatrust.runner.client import WorkerClient


def _cursor_path(root: Path | None) -> Path:
    return (root or lake_dir()) / "cursor.json"


def sync(client: WorkerClient, root: Path | None = None) -> dict[str, Any]:
    cursor_file = _cursor_path(root)
    after = json.loads(cursor_file.read_text())["after"] if cursor_file.exists() else ""
    appended = 0
    while True:
        res = client.request("GET", f"/api/dev/lake-export?after={after}")
        events = [json.loads(line) for line in res.text.splitlines() if line.strip()]
        nxt = res.headers.get("x-next-after", after)
        if events:
            appended += append(to_arrow(events), root)
        if not events or nxt == after:
            break
        after = nxt
        cursor_file.parent.mkdir(parents=True, exist_ok=True)
        cursor_file.write_text(json.dumps({"after": after}))
    return {"appended": appended, "cursor": after}
