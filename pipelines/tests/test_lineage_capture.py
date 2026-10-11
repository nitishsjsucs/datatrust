"""dbt-ol captures column lineage for every model; relations.json maps relations to unique ids (SPEC 9)."""

from __future__ import annotations

import json


def test_openlineage_events_have_column_lineage(built_101):
    events = [
        json.loads(line)
        for line in (built_101.target_path / "openlineage.jsonl").read_text().splitlines()
        if line.strip()
    ]
    runs = [e for e in events if e["eventType"] == "COMPLETE" and e["job"]["name"].endswith(".build.run")]
    assert len(runs) == 29
    with_lineage = [e for e in runs if "columnLineage" in e["outputs"][0].get("facets", {})]
    assert len(with_lineage) == 29
    # sources appear in dataset inputs (ADR-0005: raw tables are sources, not seeds)
    stg_hires = next(e for e in runs if e["outputs"][0]["name"].endswith("staging.stg_hires"))
    assert [i["name"].split(".", 1)[1] for i in stg_hires["inputs"]] == ["raw.hires"]
    # namespaces embed the absolute warehouse path, so they are never used as identity
    assert stg_hires["outputs"][0]["namespace"].startswith("duckdb:///")
    assert str(built_101.duckdb_path) in stg_hires["outputs"][0]["namespace"]


def test_relations_map(built_101):
    rel = json.loads((built_101.target_path / "relations.json").read_text())
    assert rel["dialect"] == "duckdb"
    nodes = rel["nodes"]
    assert sum(1 for n in nodes.values() if n["kind"] == "source") == 13
    assert sum(1 for n in nodes.values() if n["kind"] == "model") == 29
    fct = nodes["model.datatrust.fct_compensation_usd"]
    assert len(fct["checksum"]) == 64
    assert fct["materialization"] == "table"
    assert fct["columns"]["base_salary_usd"]["classification"] == "compensation"
    assert fct["meta"]["grain"] == ["employee_id"]
    assert nodes["source.datatrust.raw.employees"]["columns"]["work_email"]["classification"] == "pii"
