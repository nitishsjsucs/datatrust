"""`datatrust lake sync`: alias for `datatrust lake commit --catalog local` (SPEC 13.9). The cursor is the
table property `datatrust.lake.after`, written in the same Iceberg commit as the rows (lake/commit.py)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from datatrust.lake import iceberg_local
from datatrust.lake.commit import ExportSource, commit


def sync(client: ExportSource, root: Path | None = None) -> dict[str, Any]:
    return commit(iceberg_local.catalog(root), client)
