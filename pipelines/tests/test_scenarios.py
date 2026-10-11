"""The 20 registered fault scenarios (SPEC 12.1)."""

from __future__ import annotations

from collections import Counter

import pytest

from datatrust.bench.scenarios import NAMED, SCENARIOS, decoys, inject
from datatrust.dbt.overlay import apply_patches, project_files
from datatrust.synth import spec as S
from datatrust.synth.generator import generate, table_hashes

SEVERITY = {
    "S01": (1, 20),
    "S02": (1, 30),
    "S03": (3, 45),
    "S04": (1, 1),
    "S05": (1, 25),
    "S06": (1, 14),
    "S07": (1, 10),
    "S08": (1, 25),
    "S09": (1, 1),
    "S10": (1, 20),
    "S11": (1, 10),
    "S12": (1, 10),
    "S13": (1, 1),
}


def test_twenty_scenarios_thirteen_source_seven_transformation():
    assert len(SCENARIOS) == 20
    assert [s.index for s in SCENARIOS] == list(range(1, 21))
    assert len({s.id for s in SCENARIOS}) == 20
    assert Counter(s.kind for s in SCENARIOS) == {"source": 13, "transformation": 7}
    assert all((s.inject is not None) == (s.kind == "source") for s in SCENARIOS)
    assert all((s.patch is not None) == (s.kind == "transformation") for s in SCENARIOS)


def test_named_resume_defects_present():
    titles = {s.id: s.title for s in SCENARIOS}
    assert "duplicate hires" in titles["S01"]
    assert "join fan-out" in titles["T14"] and "join fan-out" in titles["T15"]
    assert "stale exchange rates" in titles["S03"]
    assert "timezone" in titles["S04"] and "timezone" in titles["T16"]
    assert set(NAMED) == {"duplicate hires", "join fan-out", "stale exchange rates", "timezone mismatches"}


def test_severity_ranges_frozen():
    assert {s.id: s.severity for s in SCENARIOS if s.kind == "source"} == SEVERITY


def test_ground_truth_nodes_and_columns_exist(parsed_manifest):
    nodes = {**parsed_manifest["nodes"], **parsed_manifest["sources"]}
    for s in SCENARIOS:
        assert s.ground_truth in nodes, s.id
        if s.ground_truth_column:
            if s.ground_truth.startswith("source."):
                table = s.ground_truth.rsplit(".", 1)[1]
                assert s.ground_truth_column in dict(S.TABLE_COLUMNS[table]), s.id
            else:
                assert s.ground_truth_column in nodes[s.ground_truth]["columns"], s.id
        for m in s.path_models:
            assert f"model.datatrust.{m}" in nodes, (s.id, m)


def test_transformation_patches_apply_and_change_the_ground_truth_model():
    files = project_files()
    for s in SCENARIOS:
        if not s.patch:
            continue
        patched = apply_patches(files, [s.patch_text() or ""])
        changed = [p for p in files if files[p] != patched[p]]
        assert len(changed) == 1, s.id
        assert changed[0].endswith(f"{s.ground_truth.rsplit('.', 1)[1]}.sql"), s.id


def test_twelve_decoys_spread_over_layers():
    ds = decoys()
    assert len(ds) == 12
    assert [d.id for d in ds] == [f"D{i:02d}" for i in range(1, 13)]
    layers = Counter(m.split("_", 1)[0] for m in (d.model for d in ds))
    assert (
        layers["stg"] >= 3
        and layers["int"] >= 2
        and layers["fct"] + layers["dim"] >= 2
        and layers["metric"] >= 1
    )


@pytest.mark.parametrize("scenario", [s for s in SCENARIOS if s.kind == "source"], ids=lambda s: s.id)
def test_source_injection_is_deterministic_and_changes_data(scenario):
    clean = table_hashes(generate(101))
    a, b = generate(101), generate(101)
    info_a, info_b = inject(a, 101, scenario), inject(b, 101, scenario)
    assert info_a == info_b
    ha, hb = table_hashes(a), table_hashes(b)
    assert ha == hb
    assert ha != clean
    lo, hi = scenario.severity or (1, 1)
    assert lo <= info_a["severity"] <= hi
