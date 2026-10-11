"""`dbt parse --target bigquery` succeeds with no credentials, no env vars and no .prod files (SPEC 7.4)."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

DBT_DIR = Path(__file__).resolve().parents[2] / "dbt"


def test_parse_bigquery_without_credentials(tmp_path):
    env = {k: v for k, v in os.environ.items() if not k.startswith(("DATATRUST_", "GOOGLE_", "CLOUDSDK_"))}
    env["DBT_SEND_ANONYMOUS_USAGE_STATS"] = "false"
    env["GOOGLE_APPLICATION_CREDENTIALS"] = str(tmp_path / "missing.json")
    dbt = Path(sys.executable).parent / "dbt"
    proc = subprocess.run(
        [
            str(dbt),
            "parse",
            "--target",
            "bigquery",
            "--project-dir",
            str(DBT_DIR),
            "--profiles-dir",
            str(DBT_DIR),
            "--target-path",
            str(tmp_path / "target"),
            "--log-path",
            str(tmp_path / "logs"),
        ],
        env=env,
        capture_output=True,
        text=True,
        cwd=tmp_path,
        check=False,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    manifest = json.loads((tmp_path / "target" / "manifest.json").read_text())
    models = {n["name"]: n for n in manifest["nodes"].values() if n["resource_type"] == "model"}
    assert len(models) == 29
    assert models["dim_employee"]["schema"] == "datatrust_marts"
    assert models["stg_hires"]["schema"] == "datatrust_staging"
    assert models["int_comp_by_dept_month"]["schema"] == "datatrust_staging"
    assert models["rpt_compensation_by_dept"]["schema"] == "datatrust_restricted"
    assert models["rpt_compensation_by_dept"]["config"]["grant_access_to"] == [
        {"project": "datatrust-ci-placeholder", "dataset": "datatrust_staging"}
    ]
    assert models["dim_employee"]["columns"]["work_email"]["data_type"] == "string"
    assert models["fct_compensation_usd"]["columns"]["base_salary_usd"]["data_type"] == "numeric"
    tags = models["dim_employee"]["columns"]["first_name"]["policy_tags"]
    assert tags == ["projects/placeholder/locations/us/taxonomies/0/policyTags/0"]
    sources = {s["name"]: s for s in manifest["sources"].values()}
    assert sources["hires"]["schema"] == "datatrust_raw"
