"""Benchmark, end-to-end mode (SPEC 12.2): every trial goes through the Worker under `wrangler dev --local`
(Miniflare): POST /api/runs, ValidationRunWorkflow, the runner leasing the dbt_build job, Queues ingesting
check results and OpenLineage events, dt-investigate, InvestigationWorkflow, the runner leasing the
diagnostics job, ranking, the template summarizer and the persisted incident.

The harness polls run and incident state instead of trusting single responses (wrangler 4.149 sometimes
logs a "code had hung" error after sendEvent although the request succeeded, SPEC 16).
"""

from __future__ import annotations

import time
from typing import Any

from datatrust.bench.scenarios import BY_ID
from datatrust.runner.client import Auth, WorkerClient, WorkerHTTPError
from datatrust.runner.loop import run_once

TERMINAL = {"passed", "failed", "stale", "error"}


class E2ETimeout(RuntimeError):
    pass


def drive(
    operator: WorkerClient, runner: WorkerClient, run_id: str, *, timeout: float = 300.0, poll: float = 0.5
) -> dict[str, Any]:
    """Run jobs until the run is terminal and (if it failed) its incident is persisted."""
    deadline = time.monotonic() + timeout
    jobs: list[dict] = []
    while time.monotonic() < deadline:
        report = run_once(runner, target="duckdb", kinds=["dbt_build", "diagnostics"], runner_id="e2e")
        if report:
            jobs.append(report)
        run = operator.get_run(run_id)
        if run["status"] in TERMINAL and (run["status"] != "failed" or run.get("incidentId")):
            return {"run": run, "jobs": jobs}
        if not report:
            time.sleep(poll)
    raise E2ETimeout(f"run {run_id} did not finish within {timeout}s")


def run_e2e(
    seeds: list[int], scenario_ids: list[str], *, base_url: str, timeout: float = 300.0, progress: bool = True
) -> list[dict[str, Any]]:
    operator = WorkerClient(base_url, Auth.local("operator"))
    runner = WorkerClient(base_url, Auth.local("runner"))
    records: list[dict[str, Any]] = []
    for seed in seeds:
        # A clean run first: the last green run is the Worker's baseline for the change signal, matching the
        # offline harness, whose baseline is the unpatched project.
        clean_id = operator.create_run("duckdb", seed)
        clean = drive(operator, runner, clean_id, timeout=timeout)
        records.append(_record(seed, None, clean_id, clean, None, 0.0))
        for sid in scenario_ids:
            t0 = time.perf_counter()
            run_id = operator.create_run("duckdb", seed, sid)
            out = drive(operator, runner, run_id, timeout=timeout)
            incident = None
            if out["run"].get("incidentId"):
                incident = _incident(operator, out["run"]["incidentId"], timeout)
            rec = _record(seed, sid, run_id, out, incident, time.perf_counter() - t0)
            records.append(rec)
            if progress:
                gt = rec["groundTruth"]
                pos = rec["ranked"].index(gt) + 1 if gt in rec["ranked"] else None
                print(
                    f"[e2e] s{seed}-{sid}: {rec['status']} failing={','.join(rec['failing'])} gt_rank={pos}",
                    flush=True,
                )
    return records


def _incident(operator: WorkerClient, incident_id: str, timeout: float) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while True:
        try:
            return operator.get_incident(incident_id)
        except WorkerHTTPError as err:
            if err.status != 404 or time.monotonic() > deadline:
                raise
            time.sleep(0.5)


def _record(
    seed: int,
    sid: str | None,
    run_id: str,
    out: dict[str, Any],
    incident: dict[str, Any] | None,
    seconds: float,
) -> dict[str, Any]:
    run = out["run"]
    scenario = BY_ID[sid] if sid else None
    return {
        "trial": f"s{seed}-{sid or 'clean'}",
        "seed": seed,
        "scenario": sid,
        "kind": scenario.kind if scenario else "clean",
        "groundTruth": scenario.ground_truth if scenario else None,
        "groundTruthColumn": scenario.ground_truth_column if scenario else None,
        "runId": run_id,
        "status": run["status"],
        "failing": sorted(run.get("failing") or []),
        "detected": bool(run.get("failing")),
        "checkCounts": run.get("checkCounts"),
        "incidentId": run.get("incidentId"),
        "ranked": [c["node"] for c in (incident or {}).get("ranked", [])],
        "summaryProvider": (incident or {}).get("summaryProvider"),
        "summaryFallback": (incident or {}).get("summaryFallback"),
        "diagnosticSqlCount": len((incident or {}).get("diagnosticSql", [])),
        "provenance": (incident or {}).get("provenance"),
        "jobs": [{k: j.get(k) for k in ("kind", "status", "seconds")} for j in out["jobs"]],
        "wallSeconds": round(seconds, 2),
    }


def parity(e2e: list[dict[str, Any]], offline: list[dict[str, Any]], k: int = 3) -> list[dict[str, Any]]:
    """Trials whose top-k lists differ between the two modes (an empty list means parity)."""
    off = {r["trial"]: r for r in offline}
    out = []
    for r in e2e:
        if not r["scenario"]:
            continue
        o = off.get(r["trial"])
        a = r["ranked"][:k]
        b = (o or {}).get("ranked", [])[:k]
        if a != b:
            out.append({"trial": r["trial"], "e2e": a, "offline": b})
    return out
