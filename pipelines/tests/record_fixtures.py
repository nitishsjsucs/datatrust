"""Re-record test fixtures from real dbt runs. Not collected by pytest.

    uv run python pipelines/tests/record_fixtures.py

run_results_contract_failure.json: seed 101 with compensation.base_salary_local_minor delivered as text
with thousands separators (scenario S13). dbt-duckdb fails the stg_compensation contract.
"""

from __future__ import annotations

import json
import re
import sys
import tempfile
from pathlib import Path

from datatrust.dbt.build import run_dbt
from datatrust.load.duckdb_loader import load_raw
from datatrust.synth.generator import generate, write_dataset

FIXTURES = Path(__file__).parent / "fixtures"


def salary_as_text(ds) -> None:
    table = ds["compensation"]
    i = table.col("base_salary_local_minor")
    table.columns[i] = ("base_salary_local_minor", "str")
    for row in table.rows:
        row[i] = f"{row[i]:,}"


def scrub(obj, root: str):
    if isinstance(obj, dict):
        return {k: scrub(v, root) for k, v in obj.items()}
    if isinstance(obj, list):
        return [scrub(v, root) for v in obj]
    if isinstance(obj, str):
        return re.sub(re.escape(root) + r"[^\s\"']*", "<scrubbed>", obj)
    return obj


def record_contract_failure() -> Path:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp).resolve()
        ds = generate(101)
        salary_as_text(ds)
        write_dataset(ds, root / "raw")
        load_raw(root / "raw", root / "warehouse.duckdb")
        res = run_dbt(["build"], target_path=root / "target", duckdb_path=root / "warehouse.duckdb")
        if res.returncode == 0:
            raise SystemExit("expected the build to fail")
        rr = res.run_results()
        rr.pop("args", None)
        rr = scrub(rr, str(root))
        rr = scrub(rr, str(Path.home()))
        out = FIXTURES / "run_results_contract_failure.json"
        out.write_text(json.dumps(rr, indent=1, sort_keys=True) + "\n")
        return out


if __name__ == "__main__":
    print(record_contract_failure(), file=sys.stderr)
