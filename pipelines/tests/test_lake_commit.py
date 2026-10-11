"""Exactly-once lake committer (SPEC 13.9, 28.5.1, 28.7) against the local SQLite catalog: the same code
commits to Basin Catalog in production. A fake export source serves NDJSON objects the way
GET /api/lake/export does (pages, x-next-after, x-more)."""

from __future__ import annotations

import json
from types import SimpleNamespace
from urllib.parse import unquote

import pyarrow as pa
import pytest

from datatrust.lake import iceberg_local
from datatrust.lake.commit import (
    CURSOR_PROPERTY,
    NAMESPACE,
    TABLE,
    PeriodicCommit,
    commit,
    commit_page,
    ensure_table,
)
from datatrust.lake.schema import to_arrow
from datatrust.prod.smoke import lake_read_back


def _event(event_id: str, run_id: str = "run_1", event_type: str = "check_result") -> dict:
    return {
        "event_id": event_id,
        "event_type": event_type,
        "environment": "local",
        "run_id": run_id,
        "occurred_at": "2026-10-10T17:00:00.000Z",
        "check_id": "U01" if event_type == "check_result" else None,
        "status": "pass",
        "node": "model.datatrust.stg_employees",
        "payload": {"failures": 0},
    }


class FakeExport:
    """Serves objects (key, events) after a cursor, `page` objects per call, like /api/lake/export."""

    def __init__(self, objects: list[tuple[str, list[dict]]], page: int = 2, on_request=None) -> None:
        self.objects = sorted(objects)
        self.page = page
        self.on_request = on_request
        self.calls: list[str] = []

    def request(self, method: str, path: str):
        assert method == "GET" and path.startswith("/api/lake/export?after=")
        after = unquote(path.split("after=", 1)[1])
        self.calls.append(after)
        if self.on_request:
            self.on_request(len(self.calls))
        rest = [o for o in self.objects if o[0] > after]
        chosen = rest[: self.page]
        text = "".join(json.dumps(e) + "\n" for _, events in chosen for e in events)
        headers = {
            "x-next-after": chosen[-1][0] if chosen else after,
            "x-more": "1" if len(rest) > len(chosen) else "0",
        }
        return SimpleNamespace(text=text, headers=headers)


def _key(i: int) -> str:
    return f"lake/2026-10-10/01M4MV{i:020d}.ndjson"


def _rows(root) -> list[dict]:
    return iceberg_local.read(root).to_pylist()


def test_commit_twice_from_the_same_objects_adds_no_rows(tmp_path):
    root = tmp_path / "lake"
    src = FakeExport([(_key(i), [_event(f"evt_{i}_a"), _event(f"evt_{i}_b")]) for i in range(5)])
    first = commit(iceberg_local.catalog(root), src)
    assert first["appended"] == 10 and first["pages"] == 3 and first["cursor"] == _key(4)
    assert commit(iceberg_local.catalog(root), src)["appended"] == 0
    # Even with the cursor rewound, the event_id check keeps every event at one row.
    table = ensure_table(iceberg_local.catalog(root))
    with table.transaction() as tx:
        tx.set_properties({CURSOR_PROPERTY: ""})
    again = commit(iceberg_local.catalog(root), src)
    assert again["appended"] == 0 and again["duplicates"] == 10
    ids = [r["event_id"] for r in _rows(root)]
    assert len(ids) == 10 and len(set(ids)) == 10


def test_an_event_in_two_objects_lands_once(tmp_path):
    root = tmp_path / "lake"
    dup = _event("evt_dup", event_type="run_completed")
    src = FakeExport(
        [(_key(1), [dup, _event("evt_x")]), (_key(2), [_event("evt_y"), dup]), (_key(3), [dup])], page=1
    )
    out = commit(iceberg_local.catalog(root), src)
    assert out["appended"] == 3 and out["events"] == 5
    assert sorted(r["event_id"] for r in _rows(root)) == ["evt_dup", "evt_x", "evt_y"]
    same_page = FakeExport([(_key(9), [_event("evt_z"), _event("evt_z")])])
    assert commit(iceberg_local.catalog(root), same_page)["appended"] == 1


def test_cursor_is_a_table_property_written_in_the_same_commit_as_the_rows(tmp_path):
    root = tmp_path / "lake"
    cat = iceberg_local.catalog(root)
    table = ensure_table(cat)
    before = len(table.metadata.metadata_log)
    r = commit_page(cat, FakeExport([(_key(1), [_event("evt_1")]), (_key(2), [_event("evt_2")])]))
    assert (r.appended, r.next_after, r.more) == (2, _key(2), False)
    table = cat.load_table(f"{NAMESPACE}.{TABLE}")
    # One page is one Iceberg commit: exactly one new metadata file holds both the snapshot and the cursor.
    assert len(table.metadata.metadata_log) == before + 1
    assert table.properties[CURSOR_PROPERTY] == _key(2)
    assert len(table.metadata.snapshots) == 1
    assert table.current_snapshot().summary["added-records"] == "2"
    # An empty page commits nothing and leaves the cursor where it was.
    empty = commit_page(cat, FakeExport([(_key(1), [_event("evt_1")])]))
    assert (empty.appended, empty.next_after) == (0, _key(2))
    assert len(cat.load_table(f"{NAMESPACE}.{TABLE}").metadata.metadata_log) == before + 1


def test_a_commit_conflict_reloads_and_retries(tmp_path):
    root = tmp_path / "lake"
    ensure_table(iceberg_local.catalog(root))

    def concurrent_writer(call: int) -> None:
        # Another committer appends the same event between our load and our commit, on the first call only.
        if call == 1:
            other = iceberg_local.catalog(root).load_table(f"{NAMESPACE}.{TABLE}")
            other.append(to_arrow([_event("evt_shared")]))

    src = FakeExport([(_key(1), [_event("evt_shared"), _event("evt_mine")])], on_request=concurrent_writer)
    r = commit_page(iceberg_local.catalog(root), src)
    assert r.attempts == 2 and r.appended == 1
    assert sorted(x["event_id"] for x in _rows(root)) == ["evt_mine", "evt_shared"]


def test_pyiceberg_replay_is_off_so_conflicts_come_back_to_the_committer(tmp_path):
    """pyiceberg would replay a failed append against the refreshed table, skipping the event_id check."""
    root = tmp_path / "lake"
    cat = iceberg_local.catalog(root)
    cat.create_namespace(NAMESPACE)
    bare = cat.create_table(f"{NAMESPACE}.{TABLE}", schema=to_arrow([]).schema)  # made without the property
    assert "commit.retry.num-retries" not in bare.properties
    assert ensure_table(cat).properties["commit.retry.num-retries"] == "0"
    assert ensure_table(iceberg_local.catalog(tmp_path / "new")).properties["commit.retry.num-retries"] == "0"


def test_gives_up_after_three_conflicts_in_a_row(tmp_path):
    root = tmp_path / "lake"
    ensure_table(iceberg_local.catalog(root))
    n = iter(range(100))

    def always_conflict(call: int) -> None:
        other = iceberg_local.catalog(root).load_table(f"{NAMESPACE}.{TABLE}")
        other.append(to_arrow([_event(f"evt_other_{next(n)}")]))

    src = FakeExport([(_key(1), [_event("evt_mine")])], on_request=always_conflict)
    with pytest.raises(RuntimeError, match="3 commit conflicts"):
        commit_page(iceberg_local.catalog(root), src)
    assert "evt_mine" not in {r["event_id"] for r in _rows(root)}


def test_periodic_commit_runs_on_its_interval_and_on_exit_and_never_raises(tmp_path):
    root = tmp_path / "lake"
    now = [0.0]
    src = FakeExport([(_key(1), [_event("evt_1")])])
    periodic = PeriodicCommit(src, lambda: iceberg_local.catalog(root), interval=900, clock=lambda: now[0])
    periodic.tick()
    assert periodic.results == []
    now[0] = 901
    periodic.tick()
    assert periodic.results[-1]["appended"] == 1
    periodic.final()
    assert periodic.results[-1]["appended"] == 0

    def broken():
        raise RuntimeError("catalog unreachable")

    failing = PeriodicCommit(src, broken, interval=0)
    failing.final()
    assert failing.results == [{"error": "RuntimeError: catalog unreachable"}]


def test_smoke_read_back_commits_until_every_run_is_in_the_table(tmp_path):
    root = tmp_path / "lake"
    objects = [(_key(1), [_event("evt_a_done", "run_a", "run_completed")])]
    src = FakeExport(objects)

    def read(run_ids):
        rows = [r for r in _rows(root) if r["run_id"] in run_ids and r["event_type"] == "run_completed"]
        return pa.Table.from_pylist(rows or [{"run_id": None}])[: len(rows)]

    def late_object(_seconds: float) -> None:
        objects.append((_key(2), [_event("evt_b_done", "run_b", "run_completed")]))
        src.objects = sorted(objects)

    rows, commits = lake_read_back(
        src,
        ["run_a", "run_b"],
        sleep=late_object,
        catalog_factory=lambda: iceberg_local.catalog(root),
        read=read,
    )
    assert rows == 2
    assert [c["appended"] for c in commits] == [1, 1]


def test_prod_runner_watch_ticks_the_periodic_commit_and_commits_on_exit(monkeypatch):
    from datatrust.runner import loop

    calls: list[str] = []
    periodic = SimpleNamespace(tick=lambda: calls.append("tick"), final=lambda: calls.append("final"))
    monkeypatch.setattr(loop, "run_once", lambda client, target, kinds: None)
    loop.watch(None, target="bigquery", kinds=["dbt_build"], idle_exit=0, periodic=periodic)  # type: ignore[arg-type]
    assert calls == ["tick", "final"]

    def boom(client, target, kinds):
        raise RuntimeError("lease failed")

    calls.clear()
    monkeypatch.setattr(loop, "run_once", boom)
    with pytest.raises(RuntimeError):
        loop.watch(None, target="bigquery", kinds=["dbt_build"], periodic=periodic)  # type: ignore[arg-type]
    assert calls == ["final"]
