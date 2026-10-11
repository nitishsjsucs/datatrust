"""Runner loop: lease a job, execute it, complete it (SPEC 14.2, ADR-0001).

dbt_build: synthesize the seed, apply the scenario if one is given (scenario + decoys, exactly as the offline
benchmark does), load, `dbt-ol build`, snapshot marts on green runs, upload relations and run_results, post
OpenLineage events in batches of 50 with the job headers, complete with check results.
diagnostics: render and run the requested probes against this runner's own warehouse and relations (never
SQL from the request), on a read-only connection; sanitize with `rca sanitize`; complete.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import socket
import time
from pathlib import Path
from typing import Any

from datatrust import config
from datatrust.runner.client import LeasedJob, WorkerClient, WorkerHTTPError

log = logging.getLogger("datatrust.runner")


def run_dir(run_id: str) -> Path:
    if not run_id.replace("_", "").isalnum():
        raise ValueError(f"unsafe run id {run_id!r}")
    return config.DATA_DIR / "runs" / run_id


def evidence_key() -> str:
    key = os.environ.get("EVIDENCE_HMAC_KEY")
    if key:
        return key
    path = config.REPO_ROOT / ".dev" / "evidence_hmac_key"
    if path.exists():
        return path.read_text().strip()
    raise RuntimeError("EVIDENCE_HMAC_KEY is not set (local: run `npm run dev:keys`)")


def snapshot_marts(db: Path, snapshot_root: Path, run_id: str, relations: dict[str, Any]) -> list[str]:
    """Parquet copies of every mart table after a green run (DuckDB stand-in for time travel, SPEC 7.3)."""
    import duckdb

    out = snapshot_root / run_id
    out.mkdir(parents=True, exist_ok=True)
    written = []
    with duckdb.connect(str(db)) as con:
        for node in relations["nodes"].values():
            if node["kind"] == "model" and node["schema"] == "marts" and node["materialization"] == "table":
                path = out / f"{node['name']}.parquet"
                con.execute(
                    f'copy (select * from "marts"."{node["identifier"]}") to \'{path}\' (format parquet)'
                )
                written.append(node["name"])
    return written


def handle_dbt_build(client: WorkerClient, job: LeasedJob) -> dict[str, Any]:
    from datatrust.bench.scenarios import BY_ID, inject, patches_for
    from datatrust.checks.results import classify
    from datatrust.dbt.build import build_with_lineage
    from datatrust.dbt.overlay import make_overlay
    from datatrust.load.duckdb_loader import load_raw
    from datatrust.synth.generator import generate, write_dataset

    p = job.payload
    target = p.get("target", "duckdb")
    seed = int(p.get("seed") or 101)
    scenario = BY_ID[p["scenario"]] if p.get("scenario") else None
    work = run_dir(job.run_id)
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)
    ds = generate(seed)
    if scenario:
        inject(ds, seed, scenario)
    write_dataset(ds, work / "raw")
    patches = patches_for(seed, scenario)[0] if scenario else []
    project = make_overlay(work / "dbt", patches)
    db = work / "warehouse.duckdb"
    snapshots = config.snapshot_dir()
    if target == "bigquery":
        from datatrust.load.bigquery_loader import load_raw_bigquery
        from datatrust.prod.settings import GcpSettings, dbt_vars_arg
        from datatrust.prod.validate import bigquery_env

        settings = GcpSettings.from_env()
        load_raw_bigquery(
            work / "raw",
            settings.project,
            settings.location,
            table_columns={name: t.columns for name, t in ds.tables.items()},
        )
        res = build_with_lineage(
            project_dir=project,
            target_path=work / "target",
            env_extra=bigquery_env(settings),
            extra_args=["--vars", dbt_vars_arg()],
        )
    else:
        load_raw(work / "raw", db)
        res = build_with_lineage(
            project_dir=project,
            target_path=work / "target",
            duckdb_path=db,
            env_extra={"DATATRUST_SNAPSHOT_DIR": str(snapshots)},
        )
    if not (work / "target" / "run_results.json").exists():
        raise RuntimeError("dbt produced no run_results.json")
    checks = [c.to_json() for c in classify(res.run_results(), res.manifest())]
    relations = json.loads((work / "target" / "relations.json").read_text())
    if target == "duckdb" and not any(c["status"] in ("fail", "error") for c in checks):
        snapshot_marts(db, snapshots, job.run_id, relations)
    client.upload_artifact(job, "relations", relations)
    client.upload_artifact(job, "run_results", _slim_run_results(res.run_results()))
    events = res.openlineage_events()
    event_ids = client.post_lineage(job, events)
    body = {"status": "completed", "checkResults": checks, "expectedLineageEvents": len(set(event_ids))}
    client.complete(job, body)
    failing = sorted(c["checkId"] for c in checks if c["status"] in ("fail", "error"))
    return {"checks": len(checks), "failing": failing, "lineageEvents": len(set(event_ids))}


def _slim_run_results(rr: dict[str, Any]) -> dict[str, Any]:
    """run_results without compiled SQL text or row values (no store_failures)."""
    keep = ("unique_id", "status", "failures", "execution_time", "message")
    return {
        "metadata": rr.get("metadata", {}),
        "elapsed_time": rr.get("elapsed_time"),
        "results": [{k: r.get(k) for k in keep} for r in rr.get("results", [])],
    }


def handle_diagnostics(client: WorkerClient, job: LeasedJob) -> dict[str, Any]:
    from datatrust.diagnostics.probes import ProbeRequest, run_probes
    from datatrust.rca_cli import rca
    from datatrust.warehouse.duckdb_wh import DuckDBWarehouse

    p = job.payload
    work = run_dir(job.run_id)
    relations = json.loads((work / "target" / "relations.json").read_text())
    requests_ = [ProbeRequest.from_json(x) for x in p.get("probes", [])]
    if p.get("target") == "bigquery":
        from datatrust.prod.settings import GcpSettings
        from datatrust.warehouse.bigquery_wh import BigQueryWarehouse

        settings = GcpSettings.from_env()
        with BigQueryWarehouse(settings.project, settings.location, principal=settings.prober_sa) as wh:
            raw = [r.to_json() for r in run_probes(requests_, wh, relations)]
    else:
        with DuckDBWarehouse(work / "warehouse.duckdb", snapshot_dir=config.snapshot_dir()) as wh:
            raw = [r.to_json() for r in run_probes(requests_, wh, relations)]
    sanitized = rca(
        "sanitize",
        {"probeResults": raw, "relations": relations},
        env_extra={"EVIDENCE_HMAC_KEY": evidence_key()},
    )["probeResults"]
    client.complete(job, {"status": "completed", "probeResults": sanitized})
    return {"probes": len(sanitized), "anomalous": sum(1 for r in sanitized if r["anomaly"] > 0)}


HANDLERS = {"dbt_build": handle_dbt_build, "diagnostics": handle_diagnostics}


def run_once(
    client: WorkerClient, *, target: str, kinds: list[str], runner_id: str | None = None
) -> dict | None:
    """Lease and run at most one job. Returns a short report, or None when no job was available."""
    job = client.lease(kinds, target, runner_id or f"{socket.gethostname()}-{os.getpid()}")
    if job is None:
        return None
    started = time.perf_counter()
    try:
        outcome = HANDLERS[job.kind](client, job)
        status = "completed"
    except WorkerHTTPError:
        raise
    except Exception as err:  # noqa: BLE001 - report the failure to the workflow, then continue
        log.exception("job %s failed", job.job_id)
        client.complete(job, {"status": "failed", "error": type(err).__name__})
        outcome, status = {"error": type(err).__name__}, "failed"
    return {
        "jobId": job.job_id,
        "runId": job.run_id,
        "kind": job.kind,
        "status": status,
        "seconds": round(time.perf_counter() - started, 2),
        **outcome,
    }


def watch(
    client: WorkerClient,
    *,
    target: str,
    kinds: list[str],
    interval: float = 2.0,
    max_jobs: int | None = None,
    idle_exit: float | None = None,
) -> list[dict]:
    """Keep leasing until stopped, `max_jobs` jobs ran, or nothing arrived for `idle_exit` seconds."""
    done: list[dict] = []
    idle_since = time.monotonic()
    while max_jobs is None or len(done) < max_jobs:
        report = run_once(client, target=target, kinds=kinds)
        if report is None:
            if idle_exit is not None and time.monotonic() - idle_since > idle_exit:
                break
            time.sleep(interval)
            continue
        idle_since = time.monotonic()
        done.append(report)
        print(json.dumps(report), flush=True)
    return done
