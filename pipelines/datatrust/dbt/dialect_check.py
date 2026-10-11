"""Constructs BigQuery rejects that `dbt parse` and sqlglot still accept (SPEC 7.3). Used by
test_dialect_macros.py on the rendered macro branches and by `datatrust prod validate` on compiled SQL."""

from __future__ import annotations

import re
from pathlib import Path

BANNED_IN_BIGQUERY: list[tuple[str, str]] = [
    (r"::", "postgres-style cast"),
    (r"median\s*\(", "median() is DuckDB-only"),
    (r"\blist\s*\(", "list() is DuckDB-only"),
    (r"\brange\s*\(", "range() is DuckDB-only"),
    (r"\btimezone\s*\(", "timezone() is DuckDB-only"),
    (r"//", "integer division operator"),
    (r"decimal\s*\(", "decimal(p,s) type"),
    (r"timestamptz", "timestamptz type"),
    (r"date_diff\s*\(\s*'", "DuckDB date_diff argument order"),
    (r"date_trunc\s*\(\s*'", "DuckDB date_trunc argument order"),
    (
        r"percentile_(cont|disc)\s*\([^)]*\)\s*over\s*\([^)]*(order\s+by|rows|range)",
        "percentile window frame",
    ),
]


def banned_hits(sql: str) -> list[str]:
    return [why for pattern, why in BANNED_IN_BIGQUERY if re.search(pattern, sql, re.I)]


def strip_comments(sql: str) -> str:
    return re.sub(r"--[^\n]*", "", re.sub(r"/\*.*?\*/", "", sql, flags=re.S))


def scan_compiled(compiled_dir: Path) -> dict[str, list[str]]:
    """Banned constructs per compiled SQL file (comments ignored)."""
    out = {}
    for path in sorted(compiled_dir.rglob("*.sql")):
        hits = banned_hits(strip_comments(path.read_text()))
        if hits:
            out[str(path.relative_to(compiled_dir))] = hits
    return out
