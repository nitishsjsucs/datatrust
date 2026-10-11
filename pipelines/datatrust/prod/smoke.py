"""`npm run prod:smoke` (SPEC 18.4): the only command that may flip a README status label to "executed in
production". Implemented, not executed: it needs the Cloudflare and Google Cloud setup in the README.

1. prod validate (skippable with --skip-validate when it passed the same day);
2. the real runner (BigQuery target, service token datatrust-runner) in a background thread, while runs are
   started and read with the second service token datatrust-operator;
3. one clean run on seed 101 that must pass with 40 checks and no incident;
4. five fault runs (S01, S03, S04, T14, T20) through the deployed Queues and Workflows, each producing an
   incident with summary_provider = workers-ai; records grounding pass rate and fallback rate;
5. reads the run_completed events of all six runs back from Basin Catalog (pyiceberg RestCatalog,
   polling up to 10 minutes);
6. Access: an unauthenticated request is denied, a service-token request succeeds, the runner token cannot
   start a run, decoded claims recorded;
7. writes results/prod-smoke-<date>.json and .md.
"""

from __future__ import annotations

import base64
import datetime as dt
import json
import os
import threading
import time
from typing import Any

import requests

from datatrust import config
from datatrust.prod.settings import GcpSettings, load_env_prod

FAULTS = ("S01", "S03", "S04", "T14", "T20")


def _claims(jwt: str) -> dict[str, Any]:
    part = jwt.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))


def versions() -> dict[str, str]:
    """Package and tool versions recorded with the smoke report (SPEC 18.4 step 7)."""
    from importlib import metadata

    out: dict[str, str] = {}
    for pkg in ("dbt-core", "dbt-bigquery", "openlineage-dbt", "google-cloud-bigquery", "pyiceberg"):
        try:
            out[pkg] = metadata.version(pkg)
        except metadata.PackageNotFoundError:
            out[pkg] = "not installed"
    wrangler = config.REPO_ROOT / "node_modules" / "wrangler" / "package.json"
    out["wrangler"] = json.loads(wrangler.read_text())["version"] if wrangler.exists() else "not installed"
    return out


def bytes_billed_since(settings: GcpSettings, start: dt.datetime, client: Any = None) -> int | str:
    """BigQuery bytes billed in the project since `start` (every identity: Nitish, prober, analyst), from
    INFORMATION_SCHEMA.JOBS_BY_PROJECT, which Owner can read. Reported, never asserted."""
    try:
        from google.cloud import bigquery

        client = client or bigquery.Client(project=settings.project, location=settings.location)
        region = f"region-{settings.location.lower()}"
        sql = (
            "select coalesce(sum(total_bytes_billed), 0) as billed "
            f"from `{settings.project}`.`{region}`.INFORMATION_SCHEMA.JOBS_BY_PROJECT "
            "where creation_time >= @start"
        )
        cfg = bigquery.QueryJobConfig(
            query_parameters=[bigquery.ScalarQueryParameter("start", "TIMESTAMP", start)]
        )
        rows = list(client.query(sql, job_config=cfg).result())
        return int(rows[0]["billed"]) if rows else 0
    except Exception as err:  # noqa: BLE001 - the report says why the figure is missing
        return f"unavailable ({type(err).__name__})"


def access_checks(base_url: str) -> dict[str, Any]:
    anon = requests.get(f"{base_url}/api/whoami", allow_redirects=False, timeout=30)
    headers = {
        "CF-Access-Client-Id": os.environ["CF_ACCESS_CLIENT_ID"],
        "CF-Access-Client-Secret": os.environ["CF_ACCESS_CLIENT_SECRET"],
    }
    svc = requests.get(f"{base_url}/api/whoami", headers=headers, timeout=30)
    # The runner token must not be able to start runs (least privilege, SPEC 15).
    forbidden = requests.post(
        f"{base_url}/api/runs", headers=headers, json={"target": "bigquery", "seed": 101}, timeout=30
    )
    # The Worker answers /api/whoami with the principal it decoded from the Access JWT; Access may also return
    # the token as the CF_Authorization cookie, whose claims are recorded when present.
    token = svc.cookies.get("CF_Authorization")
    return {
        "unauthenticated_status": anon.status_code,
        "unauthenticated_denied": anon.status_code in (302, 401, 403),
        "service_token_status": svc.status_code,
        "service_token_principal": svc.json() if svc.ok else None,
        "service_token_claims": _claims(token) if token else None,
        "runner_token_cannot_start_runs": forbidden.status_code == 403,
    }


class RunnerThread(threading.Thread):
    """The real runner (BigQuery target, service token datatrust-runner) in the background. An exception in a
    job handler is reported to the workflow by run_once; anything else (auth, network) stops the thread and
    is re-raised by the smoke instead of letting it wait for runs that can never finish."""

    def __init__(self, client: Any) -> None:
        super().__init__(daemon=True)
        self.client = client
        self.stop = threading.Event()
        self.error: BaseException | None = None
        self.jobs: list[dict[str, Any]] = []

    def run(self) -> None:
        from datatrust.runner.loop import run_once

        try:
            while not self.stop.is_set():
                report = run_once(
                    self.client, target="bigquery", kinds=["dbt_build", "diagnostics"], runner_id="prod-smoke"
                )
                if report is None:
                    self.stop.wait(3)
                else:
                    self.jobs.append(report)
        except BaseException as err:  # noqa: BLE001 - surfaced by wait_for_run
            self.error = err


def wait_for_run(ops: Any, run_id: str, runner: RunnerThread, timeout_s: float = 1800) -> dict[str, Any]:
    """Poll until the run is final (and, when it failed, until its incident exists)."""
    deadline = time.monotonic() + timeout_s
    while True:
        if runner.error is not None:
            raise RuntimeError(f"runner stopped: {type(runner.error).__name__}: {runner.error}")
        run = ops.get_run(run_id)
        if run["status"] in ("passed", "failed", "stale", "error") and (
            run["status"] != "failed" or run.get("incidentId")
        ):
            return run
        if time.monotonic() > deadline:
            raise TimeoutError(f"{run_id} still {run['status']} after {timeout_s:.0f} s")
        time.sleep(5)


def smoke(skip_validate: bool = False) -> dict[str, Any]:
    from datatrust.lake.iceberg_basin import run_completed_events
    from datatrust.prod.validate import validate
    from datatrust.runner.client import WorkerClient

    load_env_prod()
    settings = GcpSettings.from_env()
    # Two Access service tokens: datatrust-runner leases jobs (runner role only), datatrust-operator starts
    # runs and reads incidents (operator and viewer).
    client = WorkerClient.from_env("runner", "prod")
    ops = WorkerClient.from_env("operator", "prod")
    base_url = client.base_url
    started = dt.datetime.now(dt.UTC)
    report: dict[str, Any] = {
        "date": started.date().isoformat(),
        "startedAt": started.isoformat(),
        "apiUrl": base_url,
    }
    if not skip_validate:
        steps = validate()
        report["validate"] = [s.__dict__ for s in steps]
        if not all(s.ok for s in steps):
            report["ok"] = False
            return report

    runner = RunnerThread(client)
    runner.start()
    try:
        runs = []
        for scenario in (None, *FAULTS):
            run_id = ops.create_run("bigquery", 101, scenario)
            run = wait_for_run(ops, run_id, runner)
            incident = ops.get_incident(run["incidentId"]) if run.get("incidentId") else None
            runs.append(
                {
                    "scenario": scenario,
                    "runId": run_id,
                    "status": run["status"],
                    "checkCounts": run["checkCounts"],
                    "failing": run["failing"],
                    "incidentId": run.get("incidentId"),
                    "top3": [c["node"] for c in (incident or {}).get("ranked", [])[:3]],
                    "summaryProvider": (incident or {}).get("summaryProvider"),
                    "summarizer": ((incident or {}).get("provenance") or {}).get("summarizer"),
                }
            )
    finally:
        runner.stop.set()
        runner.join(timeout=60)
    report["runs"] = runs
    report["runnerJobs"] = runner.jobs
    faults = [r for r in runs if r["scenario"]]
    report["clean_ok"] = runs[0]["status"] == "passed" and runs[0]["checkCounts"]["pass"] == 40
    report["workers_ai_incidents"] = sum(1 for r in faults if r["summaryProvider"] == "workers-ai")
    report["grounding_pass_rate"] = sum(
        1 for r in faults if (r["summarizer"] or {}).get("firstDraftGrounded")
    ) / len(faults)
    report["fallback_rate"] = sum(1 for r in faults if (r["summarizer"] or {}).get("fallback")) / len(faults)

    deadline = time.monotonic() + 600
    ids = [r["runId"] for r in runs]
    rows = 0
    while time.monotonic() < deadline:
        table = run_completed_events(ids)
        rows = table.num_rows
        if len(set(table.column("run_id").to_pylist())) == len(ids):
            break
        time.sleep(20)
    report["iceberg_run_completed_rows"] = rows
    report["access"] = access_checks(base_url)
    report["bigquery_bytes_billed"] = bytes_billed_since(settings, started)
    report["versions"] = versions()
    report["workers_ai_model"] = next(
        ((r["summarizer"] or {}).get("model") for r in faults if r.get("summarizer")), None
    )
    report["ok"] = (
        report["clean_ok"]
        and report["workers_ai_incidents"] == len(FAULTS)
        and rows >= len(ids)
        and report["access"]["unauthenticated_denied"]
        and report["access"]["service_token_status"] == 200
        and report["access"]["runner_token_cannot_start_runs"]
    )
    out = config.RESULTS_DIR / f"prod-smoke-{report['date']}"
    out.with_suffix(".json").write_text(json.dumps(report, indent=1, default=str) + "\n")
    out.with_suffix(".md").write_text(
        f"# DataTrust production smoke, {report['date']}\n\n"
        f"- API: {base_url}; BigQuery project {settings.project}\n"
        f"- Clean run passed with 40 checks: {report['clean_ok']}\n"
        f"- Fault runs with Workers AI summaries: {report['workers_ai_incidents']}/{len(FAULTS)}\n"
        f"- Grounding pass rate (first draft): {report['grounding_pass_rate']:.0%}; "
        f"template fallback rate: {report['fallback_rate']:.0%}\n"
        f"- run_completed rows read back from Basin Catalog: {rows} (expected {len(ids)})\n"
        f"- Access: unauthenticated {report['access']['unauthenticated_status']}, "
        f"service token {report['access']['service_token_status']}, runner token cannot start runs: "
        f"{report['access']['runner_token_cannot_start_runs']}\n"
        f"- Workers AI model: {report['workers_ai_model']}; BigQuery bytes billed since start: "
        f"{report['bigquery_bytes_billed']}\n"
        f"- Versions: {', '.join(f'{k} {v}' for k, v in report['versions'].items())}\n"
        f"- Overall: {'passed' if report['ok'] else 'FAILED'}\n"
    )
    return report
