"""Every (scenario, decoy set) drawn for seeds 1-3 and 101-105 applies cleanly (SPEC 12.1), and decoys
are benign: all 12 together build seed 101 with 40 passing checks."""

from __future__ import annotations

import json
from collections import Counter

import pytest

from datatrust.bench.scenarios import DEV_SEEDS, SCENARIOS, TEST_SEEDS, decoys, draw_decoys, patches_for
from datatrust.dbt.build import run_dbt
from datatrust.dbt.overlay import PatchError, apply_patches, make_overlay, project_files
from datatrust.load.duckdb_loader import load_raw
from datatrust.synth.generator import generate, write_dataset


@pytest.mark.parametrize("seed", [*DEV_SEEDS, *TEST_SEEDS])
def test_all_drawn_combinations_apply(seed):
    files = project_files()
    for scenario in [None, *SCENARIOS]:
        patches, ids = patches_for(seed, scenario)
        assert 0 <= len(ids) <= 4
        patched = apply_patches(files, patches)  # raises PatchError on any conflict
        assert patched.keys() == files.keys()


def test_decoy_draw_is_deterministic_and_varied():
    draws = [
        tuple(d.id for d in draw_decoys(seed, s.index))
        for seed in [*DEV_SEEDS, *TEST_SEEDS]
        for s in SCENARIOS
    ]
    again = [
        tuple(d.id for d in draw_decoys(seed, s.index))
        for seed in [*DEV_SEEDS, *TEST_SEEDS]
        for s in SCENARIOS
    ]
    assert draws == again
    sizes = Counter(len(d) for d in draws)
    assert set(sizes) == {0, 1, 2, 3, 4}


def test_on_path_decoys_are_drawn():
    hits = 0
    total = 0
    for seed in [*DEV_SEEDS, *TEST_SEEDS]:
        for s in SCENARIOS:
            chosen = draw_decoys(seed, s.index)
            if chosen and s.path_models:
                total += 1
                hits += any(d.model in s.path_models for d in chosen)
    assert total > 0 and hits / total > 0.3


def test_conflicting_patch_is_rejected():
    bad = (
        "--- a/models/staging/stg_hires.sql\n+++ b/models/staging/stg_hires.sql\n"
        "@@ -1,1 +1,1 @@\n-no such line\n+x\n"
    )
    with pytest.raises(PatchError):
        apply_patches(project_files(), [bad])


def test_all_decoys_together_are_benign(tmp_path):
    project = make_overlay(tmp_path / "dbt", [d.text() for d in decoys()])
    write_dataset(generate(101), tmp_path / "raw")
    load_raw(tmp_path / "raw", tmp_path / "w.duckdb")
    res = run_dbt(
        ["build"], project_dir=project, target_path=tmp_path / "target", duckdb_path=tmp_path / "w.duckdb"
    )
    assert res.returncode == 0, res.stdout[-3000:]
    rr = json.loads((tmp_path / "target" / "run_results.json").read_text())
    statuses = Counter(r["status"] for r in rr["results"])
    assert statuses == {"success": 29, "pass": 40}
    manifest = json.loads((tmp_path / "target" / "manifest.json").read_text())
    changed = {d.model for d in decoys()}
    assert len(changed) == 12
    assert all(f"model.datatrust.{m}" in manifest["nodes"] for m in changed)
