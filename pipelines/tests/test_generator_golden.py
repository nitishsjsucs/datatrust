"""Cross-platform determinism: seed 101 hashes must match the committed golden file (SPEC 6.1).

CI runs this on ubuntu-latest, so macOS and Linux must produce byte-identical canonical CSV.
"""

from __future__ import annotations

import json
from pathlib import Path

import tzdata

from datatrust.synth.generator import table_hashes

GOLDEN = Path(__file__).parent / "golden" / "seed101.sha256.json"


def test_tzdata_pinned():
    assert tzdata.IANA_VERSION == "2026e"


def test_seed101_matches_golden(dataset_factory):
    golden = json.loads(GOLDEN.read_text())
    assert golden["seed"] == 101
    assert table_hashes(dataset_factory(101)) == golden["tables"]


def test_written_manifest_matches_hashes(dataset_factory, tmp_path):
    from datatrust.synth.generator import write_dataset

    ds = dataset_factory(101)
    m = write_dataset(ds, tmp_path)
    assert m["total_rows"] == 43_190
    assert {k: v["sha256"] for k, v in m["tables"].items()} == table_hashes(ds)
    assert sorted(p.name for p in tmp_path.glob("*.parquet")) == sorted(f"{t}.parquet" for t in ds.tables)
