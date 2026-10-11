from __future__ import annotations

import functools
from dataclasses import dataclass
from pathlib import Path

import pytest

from datatrust.synth.generator import Dataset, generate, write_dataset


@functools.lru_cache(maxsize=8)
def _cached(seed: int) -> Dataset:
    return generate(seed)


@pytest.fixture(scope="session")
def dataset_factory():
    """Generated datasets are deterministic, so they are shared across tests (read-only)."""
    return _cached


@dataclass
class BuiltWarehouse:
    seed: int
    duckdb_path: Path
    target_path: Path
    returncode: int
    output: str

    def connect(self):
        from datatrust.load.duckdb_loader import connect

        return connect(self.duckdb_path, read_only=True)


def build_warehouse(seed: int, root: Path) -> BuiltWarehouse:
    """Generate, load and `dbt-ol build` (the runner's path), with OpenLineage events and relations.json."""
    from datatrust.dbt.build import build_with_lineage
    from datatrust.load.duckdb_loader import load_raw

    raw = root / "raw"
    write_dataset(_cached(seed), raw)
    db = root / "warehouse.duckdb"
    load_raw(raw, db)
    res = build_with_lineage(target_path=root / "target", duckdb_path=db)
    return BuiltWarehouse(seed, db, root / "target", res.returncode, res.stdout)


@pytest.fixture(scope="session")
def built_101(tmp_path_factory) -> BuiltWarehouse:
    """Seed 101, clean, full `dbt build` on a fresh DuckDB file."""
    return build_warehouse(101, tmp_path_factory.mktemp("wh101"))


@pytest.fixture(scope="session")
def parsed_manifest(tmp_path_factory) -> dict:
    """`dbt parse` on the DuckDB target; no warehouse data needed."""
    import json

    from datatrust.dbt.build import run_dbt

    root = tmp_path_factory.mktemp("parse")
    res = run_dbt(["parse"], target_path=root / "target", duckdb_path=root / "parse.duckdb")
    assert res.returncode == 0, res.stdout
    return json.loads((root / "target" / "manifest.json").read_text())


@pytest.fixture(scope="session")
def built_101_results(built_101):
    import json

    from datatrust.checks.results import classify

    rr = json.loads((built_101.target_path / "run_results.json").read_text())
    manifest = json.loads((built_101.target_path / "manifest.json").read_text())
    return classify(rr, manifest)


@pytest.fixture(scope="session")
def all_planned_probes(built_101, built_101_results):
    """Probe requests the TypeScript planner produces when every one of the 40 checks fails (seed 101)."""
    import json

    from datatrust.rca_cli import rca

    rel = json.loads((built_101.target_path / "relations.json").read_text())
    events = [
        json.loads(line)
        for line in (built_101.target_path / "openlineage.jsonl").read_text().splitlines()
        if line.strip()
    ]
    checks = [{**r.to_json(), "status": "fail"} for r in built_101_results]
    plan = rca("plan", {"checks": checks, "events": events, "relations": rel})
    return rel, plan["probes"]
