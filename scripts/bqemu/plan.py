"""Host side of scripts/bq-emulator-check.sh: every probe the TypeScript planner produces for seed 101
when all 40 checks fail, from a local DuckDB `dbt-ol build` (node ids are the same on BigQuery)."""

import json
import sys
import tempfile
from pathlib import Path

from datatrust.checks.results import classify
from datatrust.dbt.build import build_with_lineage
from datatrust.load.duckdb_loader import load_raw
from datatrust.rca_cli import rca
from datatrust.synth.generator import generate, write_dataset

root = Path(tempfile.mkdtemp(prefix="dt-bqemu-plan-"))
write_dataset(generate(101), root / "raw")
load_raw(root / "raw", root / "wh.duckdb")
res = build_with_lineage(target_path=root / "target", duckdb_path=root / "wh.duckdb")
rel = json.loads((root / "target" / "relations.json").read_text())
checks = [{**c.to_json(), "status": "fail"} for c in classify(res.run_results(), res.manifest())]
plan = rca("plan", {"checks": checks, "events": res.openlineage_events(), "relations": rel})
Path(sys.argv[1]).write_text(json.dumps(plan["probes"]))
print(f"{len(plan['probes'])} planned probes")
