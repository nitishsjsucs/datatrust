"""Re-record test fixtures from real dbt runs. Not collected by pytest.

    uv run python pipelines/tests/record_fixtures.py

run_results_contract_failure.json: seed 101 with compensation.base_salary_local_minor delivered as text
with thousands separators (scenario S13). dbt-duckdb fails the stg_compensation contract.

packages/rca/test/fixtures/openlineage.seed101.jsonl and relations.seed101.json: a clean seed 101
`dbt-ol build` on DuckDB. Only COMPLETE events are kept, and every DuckDB namespace (which embeds the
absolute warehouse path) is scrubbed to duckdb:///<scrubbed>.
"""

from __future__ import annotations

import json
import re
import sys
import tempfile
from pathlib import Path

from datatrust.dbt.build import build_with_lineage, run_dbt
from datatrust.load.duckdb_loader import load_raw
from datatrust.synth.generator import generate, write_dataset

FIXTURES = Path(__file__).parent / "fixtures"
RCA_FIXTURES = Path(__file__).resolve().parents[2] / "packages" / "rca" / "test" / "fixtures"


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


def scrub_namespaces(obj):
    if isinstance(obj, dict):
        return {k: scrub_namespaces(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [scrub_namespaces(v) for v in obj]
    if isinstance(obj, str) and obj.startswith("duckdb:///"):
        return "duckdb:///<scrubbed>"
    return obj


def record_lineage() -> list[Path]:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp).resolve()
        write_dataset(generate(101), root / "raw")
        load_raw(root / "raw", root / "warehouse.duckdb")
        res = build_with_lineage(target_path=root / "target", duckdb_path=root / "warehouse.duckdb")
        if res.returncode != 0:
            raise SystemExit(res.stdout[-3000:])
        events = [scrub_namespaces(e) for e in res.openlineage_events() if e["eventType"] == "COMPLETE"]
        events = [scrub(e, str(root)) for e in events]
        events = [scrub(e, str(Path.home())) for e in events]
        RCA_FIXTURES.mkdir(parents=True, exist_ok=True)
        ev_path = RCA_FIXTURES / "openlineage.seed101.jsonl"
        ev_path.write_text("".join(json.dumps(e, sort_keys=True) + "\n" for e in events))
        rel = json.loads((root / "target" / "relations.json").read_text())
        rel = scrub(rel, str(root))
        rel_path = RCA_FIXTURES / "relations.seed101.json"
        rel_path.write_text(json.dumps(rel, indent=1, sort_keys=True) + "\n")
        return [ev_path, rel_path]


def record_worker_investigation() -> Path:
    """apps/worker/test/fixtures/investigation.s01.seed101.json for the Workflow tests: checks, relations,
    model-run OpenLineage events and sanitized probe results of a real S01 (duplicate hires) trial,
    seed 101."""
    from datatrust.bench.harness import BENCH_KEY
    from datatrust.bench.scenarios import BY_ID, inject, patches_for
    from datatrust.checks.results import classify
    from datatrust.dbt.overlay import make_overlay
    from datatrust.diagnostics.probes import ProbeRequest, run_probes
    from datatrust.rca_cli import rca
    from datatrust.warehouse.duckdb_wh import DuckDBWarehouse

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp).resolve()
        scenario = BY_ID["S01"]
        ds = generate(101)
        inject(ds, 101, scenario)
        write_dataset(ds, root / "raw")
        project = make_overlay(root / "dbt", patches_for(101, scenario)[0])
        load_raw(root / "raw", root / "warehouse.duckdb")
        res = build_with_lineage(
            project_dir=project, target_path=root / "target", duckdb_path=root / "warehouse.duckdb"
        )
        checks = [c.to_json() for c in classify(res.run_results(), res.manifest())]
        rel = json.loads((root / "target" / "relations.json").read_text())
        events = [scrub_namespaces(e) for e in res.openlineage_events()]
        events = [
            e for e in events if e["eventType"] == "COMPLETE" and e["job"]["name"].endswith(".build.run")
        ]
        plan = rca("plan", {"checks": checks, "events": events, "relations": rel})
        with DuckDBWarehouse(root / "warehouse.duckdb") as wh:
            raw = [
                r.to_json() for r in run_probes([ProbeRequest.from_json(p) for p in plan["probes"]], wh, rel)
            ]
        sanitized = rca(
            "sanitize", {"probeResults": raw, "relations": rel}, env_extra={"EVIDENCE_HMAC_KEY": BENCH_KEY}
        )["probeResults"]
        out = Path(__file__).resolve().parents[2] / "apps" / "worker" / "test" / "fixtures"
        path = out / "investigation.s01.seed101.json"
        doc = {
            "checks": checks,
            "relations": scrub(rel, str(root)),
            "events": events,
            "probeResults": sanitized,
        }
        path.write_text(json.dumps(doc, sort_keys=True) + "\n")
        return path


if __name__ == "__main__":
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    if which in ("all", "contract"):
        print(record_contract_failure(), file=sys.stderr)
    if which in ("all", "lineage"):
        print(record_lineage(), file=sys.stderr)
    if which in ("all", "worker"):
        print(record_worker_investigation(), file=sys.stderr)
