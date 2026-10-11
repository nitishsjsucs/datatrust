"""`datatrust lake commit`: add settled audit-event objects to the Iceberg table exactly once per event_id
(SPEC 13.9, 28.5.1, ADR-0008).

Per page: read the cursor from the table property `datatrust.lake.after`, fetch the next settled objects
from `GET /api/lake/export?after=<cursor>`, drop events whose event_id is already in the table or repeated
in the page, then append the rest and move the cursor in ONE Iceberg transaction. A commit conflict (another
committer got there first) reloads the table and retries, at most 3 times. So each event lands once and the
cursor never moves without its rows.

The same code serves both catalogs: `local` is the pyiceberg SQL catalog stand-in (SQLite), `basin` is
Basin Catalog through pyiceberg's REST catalog.
"""

from __future__ import annotations

import json
import logging
import os
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Any, Protocol
from urllib.parse import quote

from pyiceberg.catalog import Catalog
from pyiceberg.exceptions import (
    CommitFailedException,
    NamespaceAlreadyExistsError,
    NoSuchTableError,
    TableAlreadyExistsError,
)
from pyiceberg.expressions import In
from pyiceberg.table import Table

from datatrust.lake.schema import arrow_schema, to_arrow

log = logging.getLogger("datatrust.lake")

NAMESPACE = "datatrust"
TABLE = "audit_events"
CURSOR_PROPERTY = "datatrust.lake.after"
# pyiceberg 0.12 replays a failed append against the refreshed table on its own (4 retries by default). That
# replay would skip our event_id check and could append a row another committer already added, so the
# table turns it off and this module handles conflicts itself (reload, re-read cursor, re-check ids).
NO_AUTO_RETRY = {"commit.retry.num-retries": "0"}
COMMIT_ATTEMPTS = 3
ID_CHUNK = 500


class ExportSource(Protocol):
    """Anything with the WorkerClient.request signature (tests pass a fake)."""

    def request(self, method: str, path: str) -> Any: ...


@dataclass
class PageResult:
    after: str
    next_after: str
    events: int
    appended: int
    more: bool
    attempts: int


def ensure_table(catalog: Catalog) -> Table:
    """Load datatrust.audit_events, creating the namespace and table (schema from the lake JSON) if needed,
    with pyiceberg's automatic commit replay turned off (NO_AUTO_RETRY)."""
    try:
        catalog.create_namespace(NAMESPACE)
    except NamespaceAlreadyExistsError:
        pass
    ident = f"{NAMESPACE}.{TABLE}"
    try:
        table = catalog.load_table(ident)
    except NoSuchTableError:
        try:
            table = catalog.create_table(ident, schema=arrow_schema(), properties=NO_AUTO_RETRY)
        except TableAlreadyExistsError:
            table = catalog.load_table(ident)
    if any(table.properties.get(k) != v for k, v in NO_AUTO_RETRY.items()):
        try:
            with table.transaction() as tx:  # no snapshot, so pyiceberg does not replay it either
                tx.set_properties(NO_AUTO_RETRY)
        except CommitFailedException:
            pass  # someone else changed the table; the reload below shows whether they set it
        table = catalog.load_table(ident)
    return table


def existing_ids(table: Table, ids: Iterable[str]) -> set[str]:
    """Which of these event ids the table already holds (a scan of one column, in chunks)."""
    wanted = sorted(set(ids))
    if not wanted or table.current_snapshot() is None:
        return set()
    found: set[str] = set()
    for i in range(0, len(wanted), ID_CHUNK):
        chunk = wanted[i : i + ID_CHUNK]
        rows = table.scan(row_filter=In("event_id", chunk), selected_fields=("event_id",)).to_arrow()
        found.update(rows.column("event_id").to_pylist())
    return found


def fetch_page(source: ExportSource, after: str) -> tuple[list[dict[str, Any]], str, bool]:
    res = source.request("GET", f"/api/lake/export?after={quote(after, safe='')}")
    events = [json.loads(line) for line in res.text.splitlines() if line.strip()]
    return events, res.headers.get("x-next-after", after), res.headers.get("x-more") == "1"


def commit_page(catalog: Catalog, source: ExportSource) -> PageResult:
    """Commit the next page of settled objects. Raises after COMMIT_ATTEMPTS conflicts in a row."""
    for attempt in range(1, COMMIT_ATTEMPTS + 1):
        table = ensure_table(catalog)
        after = table.properties.get(CURSOR_PROPERTY, "")
        events, next_after, more = fetch_page(source, after)
        if next_after == after and not events:
            return PageResult(after, after, 0, 0, False, attempt)
        unique: dict[str, dict[str, Any]] = {}
        for e in events:
            unique.setdefault(str(e["event_id"]), e)
        present = existing_ids(table, unique)
        new = [e for eid, e in unique.items() if eid not in present]
        try:
            with table.transaction() as tx:
                if new:
                    tx.append(to_arrow(new))
                tx.set_properties({CURSOR_PROPERTY: next_after})
        except CommitFailedException as err:
            log.warning("lake commit conflict (attempt %d of %d): %s", attempt, COMMIT_ATTEMPTS, err)
            continue
        return PageResult(after, next_after, len(events), len(new), more, attempt)
    raise RuntimeError(f"lake commit: {COMMIT_ATTEMPTS} commit conflicts in a row; rerun later")


def commit(catalog: Catalog, source: ExportSource, max_pages: int = 1000) -> dict[str, Any]:
    """Commit every settled page. Returns counts and the final cursor."""
    appended = events = pages = 0
    cursor = ""
    for _ in range(max_pages):
        r = commit_page(catalog, source)
        cursor = r.next_after
        if r.next_after != r.after:
            pages += 1
        appended += r.appended
        events += r.events
        if not r.more:
            break
    return {
        "appended": appended,
        "events": events,
        "duplicates": events - appended,
        "pages": pages,
        "cursor": cursor,
    }


def catalog_for(kind: str) -> Catalog:
    if kind == "local":
        from datatrust.lake.iceberg_local import catalog

        return catalog()
    if kind == "basin":
        from datatrust.lake.iceberg_basin import catalog

        return catalog()
    raise ValueError(f"unknown catalog {kind!r}")


def basin_configured() -> bool:
    return all(os.environ.get(k) for k in ("BASIN_CATALOG_URI", "BASIN_WAREHOUSE", "BASIN_CATALOG_TOKEN"))


class PeriodicCommit:
    """Used by `datatrust runner --env prod --watch`: commit to Basin Catalog every `interval` seconds and
    once on exit (SPEC 14.2, 28.5.1). A failure is logged, never fatal to the runner: the R2 objects stay the
    durable record and the next commit picks them up."""

    def __init__(
        self,
        source: ExportSource,
        catalog_factory: Callable[[], Catalog],
        interval: float = 900.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.source = source
        self.catalog_factory = catalog_factory
        self.interval = interval
        self.clock = clock
        self.last = clock()
        self.results: list[dict[str, Any]] = []

    def _run(self) -> None:
        self.last = self.clock()
        try:
            out = commit(self.catalog_factory(), self.source)
            self.results.append(out)
            log.info("lake commit: %s", json.dumps(out))
        except Exception as err:  # noqa: BLE001 - logged; the next commit retries from the same cursor
            self.results.append({"error": f"{type(err).__name__}: {err}"})
            log.warning("lake commit failed: %s: %s", type(err).__name__, err)

    def tick(self) -> None:
        if self.clock() - self.last >= self.interval:
            self._run()

    def final(self) -> None:
        self._run()
