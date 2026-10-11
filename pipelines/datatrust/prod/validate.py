"""`datatrust prod validate` (SPEC 18.1 step 19): prove the BigQuery path before any real build, stopping at
the first failure and printing the BigQuery error. Implemented, not executed.

  a. refuse while any project or policy-tag placeholder is in effect;
  b. load seed 101 into datatrust_raw and assert the loaded types (TIMESTAMP instants, INT64/NUMERIC money);
  c. dbt compile --target bigquery;
  d. dbt-ol build --target bigquery --empty: every model and test runs on BigQuery against zero-row inputs;
  e. a free dry run of every rendered probe as datatrust-prober against the now-existing relations;
  f. the banned-construct check on the compiled BigQuery SQL.
"""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from datatrust import config
from datatrust.prod.settings import GcpSettings, dbt_vars_arg


@dataclass
class StepResult:
    step: str
    ok: bool
    detail: str = ""
    data: dict[str, Any] = field(default_factory=dict)


def bigquery_env(settings: GcpSettings) -> dict[str, str]:
    return {
        "DATATRUST_DBT_TARGET": "bigquery",
        "DATATRUST_GCP_PROJECT": settings.project,
        "DATATRUST_BQ_LOCATION": settings.location,
    }


def validate(work_dir: Path | None = None) -> list[StepResult]:
    from datatrust.checks.results import classify
    from datatrust.dbt.build import build_with_lineage, run_dbt
    from datatrust.dbt.dialect_check import scan_compiled
    from datatrust.diagnostics.probes import ProbeRequest, render
    from datatrust.load.bigquery_loader import load_raw_bigquery
    from datatrust.rca_cli import rca
    from datatrust.synth.generator import generate, write_dataset
    from datatrust.warehouse.bigquery_wh import BigQueryWarehouse

    results: list[StepResult] = []

    def stop(step: str, detail: str) -> list[StepResult]:
        results.append(StepResult(step, False, detail[-4000:]))
        return results

    # a
    try:
        settings = GcpSettings.from_env()
        vars_arg = dbt_vars_arg()
    except Exception as err:  # noqa: BLE001 - NotConfigured carries the fix
        return stop("a. placeholders", str(err))
    results.append(StepResult("a. placeholders", True, f"project {settings.project}"))

    work = work_dir or Path(tempfile.mkdtemp(prefix="dt-validate-"))
    # b
    try:
        write_dataset(generate(101), work / "raw")
        counts = load_raw_bigquery(work / "raw", settings.project, settings.location)
    except Exception as err:  # noqa: BLE001
        return stop("b. load seed 101", f"{type(err).__name__}: {err}")
    results.append(StepResult("b. load seed 101", True, f"{sum(counts.values())} rows", {"rows": counts}))

    env = bigquery_env(settings)
    # c
    res = run_dbt(["compile", "--vars", vars_arg], target_path=work / "compile", env_extra=env)
    if res.returncode != 0:
        return stop("c. dbt compile --target bigquery", res.stdout)
    results.append(StepResult("c. dbt compile --target bigquery", True))

    # d
    built = build_with_lineage(
        target_path=work / "empty", env_extra=env, extra_args=["--empty", "--vars", vars_arg]
    )
    if built.returncode != 0:
        return stop("d. dbt build --empty", built.stdout)
    checks = [c.to_json() for c in classify(built.run_results(), built.manifest())]
    results.append(StepResult("d. dbt build --empty", True, f"{len(checks)} checks executed on empty inputs"))

    # e
    relations = json.loads((work / "empty" / "relations.json").read_text())
    events = built.openlineage_events()
    plan = rca(
        "plan",
        {"checks": [{**c, "status": "fail"} for c in checks], "events": events, "relations": relations},
    )
    bytes_total = 0
    with BigQueryWarehouse(settings.project, settings.location, principal=settings.prober_sa) as wh:
        for p in plan["probes"]:
            try:
                for sql in render(
                    ProbeRequest.from_json(p), relations, "bigquery", wh.relation_columns
                ).values():
                    bytes_total += wh.dry_run(sql)
            except Exception as err:  # noqa: BLE001
                return stop("e. probe dry runs", f"{p['probeId']}: {type(err).__name__}: {err}")
    results.append(
        StepResult("e. probe dry runs", True, f"{len(plan['probes'])} probes, {bytes_total} bytes")
    )

    # f
    hits = scan_compiled(work / "compile" / "compiled")
    if hits:
        return stop("f. banned constructs", json.dumps(hits, indent=1))
    results.append(StepResult("f. banned constructs", True))
    return results


def main() -> int:
    out = validate(
        Path(os.environ["DATATRUST_VALIDATE_DIR"]) if os.environ.get("DATATRUST_VALIDATE_DIR") else None
    )
    for r in out:
        print(f"[{'ok' if r.ok else 'FAILED'}] {r.step} {r.detail}")
    (config.REPO_ROOT / ".prod").mkdir(exist_ok=True)
    return 0 if all(r.ok for r in out) else 1
