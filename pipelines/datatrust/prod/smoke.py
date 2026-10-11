"""`npm run prod:smoke` (SPEC 18.4): the only command that may flip a README status label to "executed in
production". Implemented, not executed: it needs the Cloudflare and Google Cloud setup in the README.

1. prod validate (skippable with --skip-validate when it passed the same day);
2. the real runner (BigQuery target, Access service token) in a background thread;
3. one clean run on seed 101 that must pass with 40 checks and no incident;
4. five fault runs (S01, S03, S04, T14, T20) through the deployed Queues and Workflows, each producing an
   incident with summary_provider = workers-ai; records grounding pass rate and fallback rate;
5. reads the run_completed events of all six runs back from Basin Catalog (pyiceberg RestCatalog,
   polling up to 10 minutes);
6. Access: an unauthenticated request is denied, a service-token request succeeds, decoded claims recorded;
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


def access_checks(base_url: str) -> dict[str, Any]:
    anon = requests.get(f"{base_url}/api/whoami", allow_redirects=False, timeout=30)
    headers = {
        "CF-Access-Client-Id": os.environ["CF_ACCESS_CLIENT_ID"],
        "CF-Access-Client-Secret": os.environ["CF_ACCESS_CLIENT_SECRET"],
    }
    svc = requests.get(f"{base_url}/api/whoami", headers=headers, timeout=30)
    # The Worker answers /api/whoami with the principal it decoded from the Access JWT; Access may also return
    # the token as the CF_Authorization cookie, whose claims are recorded when present.
    token = svc.cookies.get("CF_Authorization")
    return {
        "unauthenticated_status": anon.status_code,
        "unauthenticated_denied": anon.status_code in (302, 401, 403),
        "service_token_status": svc.status_code,
        "service_token_principal": svc.json() if svc.ok else None,
        "service_token_claims": _claims(token) if token else None,
    }


def smoke(skip_validate: bool = False) -> dict[str, Any]:
    from datatrust.lake.iceberg_basin import run_completed_events
    from datatrust.prod.validate import validate
    from datatrust.runner.client import WorkerClient
    from datatrust.runner.loop import run_once

    load_env_prod()
    settings = GcpSettings.from_env()
    base_url = os.environ["DATATRUST_API_URL"]
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

    client = WorkerClient.from_env("runner", "prod")
    stop = threading.Event()

    def runner_thread() -> None:
        while not stop.is_set():
            if (
                run_once(
                    client, target="bigquery", kinds=["dbt_build", "diagnostics"], runner_id="prod-smoke"
                )
                is None
            ):
                stop.wait(3)

    t = threading.Thread(target=runner_thread, daemon=True)
    t.start()
    try:
        runs = []
        for scenario in (None, *FAULTS):
            run_id = client.create_run("bigquery", 101, scenario)
            deadline = time.monotonic() + 1800
            while True:
                run = client.get_run(run_id)
                if run["status"] in ("passed", "failed", "stale", "error") and (
                    run["status"] != "failed" or run.get("incidentId")
                ):
                    break
                if time.monotonic() > deadline:
                    raise TimeoutError(run_id)
                time.sleep(5)
            incident = client.get_incident(run["incidentId"]) if run.get("incidentId") else None
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
        stop.set()
        t.join(timeout=60)
    report["runs"] = runs
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
    report["ok"] = (
        report["clean_ok"]
        and report["workers_ai_incidents"] == len(FAULTS)
        and rows >= len(ids)
        and report["access"]["unauthenticated_denied"]
        and report["access"]["service_token_status"] == 200
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
        f"service token {report['access']['service_token_status']}\n"
        f"- Overall: {'passed' if report['ok'] else 'FAILED'}\n"
    )
    return report
