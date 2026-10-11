"""Worker API client for the runner (SPEC 13.1, 14.2, 15).

Local: an Access-style dev JWT in `Cf-Access-Jwt-Assertion` (DATATRUST_DEV_TOKEN, or minted with
`node scripts/dev-token.mjs`). Production: the Access service token headers `CF-Access-Client-Id` and
`CF-Access-Client-Secret`; Cloudflare Access turns them into the JWT the Worker verifies.
Retries with exponential backoff on 5xx and network errors; 4xx responses are fatal.
"""

from __future__ import annotations

import json
import os
import subprocess
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import requests

from datatrust import config

LEASE_HEADER = "X-DataTrust-Lease-Token"
JOB_HEADER = "X-DataTrust-Job-Id"
# The Worker answers 413 above these (SPEC 28.5.2): 10 events and 256 KB per lineage POST keep its CPU near
# 3 ms on the Free plan's 10 ms, and each POST is announced by one queue message.
LINEAGE_POST_MAX_EVENTS = 10
LINEAGE_POST_MAX_BYTES = 262_144


def lineage_batches(events: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    """Greedy batches of at most LINEAGE_POST_MAX_EVENTS events whose JSON body (as `requests` sends it)
    stays within LINEAGE_POST_MAX_BYTES."""
    batches: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    size = 2  # "[" and "]"
    for event in events:
        n = len(json.dumps(event).encode())
        if n + 2 > LINEAGE_POST_MAX_BYTES:
            raise ValueError(f"an OpenLineage event of {n} bytes is larger than one lineage POST allows")
        extra = n + (2 if current else 0)  # ", " separator
        if current and (len(current) >= LINEAGE_POST_MAX_EVENTS or size + extra > LINEAGE_POST_MAX_BYTES):
            batches.append(current)
            current, size, extra = [], 2, n
        current.append(event)
        size += extra
    if current:
        batches.append(current)
    return batches


class WorkerHTTPError(RuntimeError):
    def __init__(self, status: int, path: str, body: str) -> None:
        super().__init__(f"{status} from {path}: {body[:500]}")
        self.status = status
        self.path = path
        self.body = body


def mint_dev_token(role: str) -> str:
    proc = subprocess.run(
        ["node", str(config.REPO_ROOT / "scripts" / "dev-token.mjs"), "--role", role],
        capture_output=True,
        text=True,
        check=True,
    )
    return proc.stdout.strip()


@dataclass
class Auth:
    headers: dict[str, str]

    @staticmethod
    def local(role: str = "runner", token: str | None = None) -> Auth:
        if token is None and role == "runner":
            token = os.environ.get("DATATRUST_DEV_TOKEN")
        return Auth({"Cf-Access-Jwt-Assertion": token or mint_dev_token(role)})

    @staticmethod
    def service_token(role: str = "runner") -> Auth:
        """Access service-token headers. The runner uses `datatrust-runner` (CF_ACCESS_CLIENT_*), which maps
        to the runner role only; starting runs and reading incidents (operator, viewer) uses the second token
        `datatrust-operator` (CF_ACCESS_OPERATOR_CLIENT_*)."""
        prefix = "CF_ACCESS_CLIENT" if role == "runner" else "CF_ACCESS_OPERATOR_CLIENT"
        cid, secret = os.environ.get(f"{prefix}_ID"), os.environ.get(f"{prefix}_SECRET")
        if not cid or not secret:
            token = "datatrust-runner" if role == "runner" else "datatrust-operator"
            raise RuntimeError(
                f"{prefix}_ID and {prefix}_SECRET (service token {token}) are required for --env prod; "
                "put them in .env.prod (README, production setup)"
            )
        return Auth({"CF-Access-Client-Id": cid, "CF-Access-Client-Secret": secret})


@dataclass
class LeasedJob:
    job_id: str
    run_id: str
    kind: str
    payload: dict[str, Any]
    lease_token: str
    attempts: int

    def headers(self) -> dict[str, str]:
        return {LEASE_HEADER: self.lease_token, JOB_HEADER: self.job_id}


@dataclass
class WorkerClient:
    base_url: str
    auth: Auth
    timeout: float = 60.0
    max_attempts: int = 5
    backoff: float = 0.5
    sleep: Callable[[float], None] = time.sleep
    session: requests.Session = field(default_factory=requests.Session)

    @staticmethod
    def from_env(role: str = "runner", env: str = "local") -> WorkerClient:
        """Local: the Worker under `wrangler dev` with a dev JWT for `role`. Production: .env.prod is loaded
        (without overriding the shell), DATATRUST_API_URL must name the deployed Worker, and the Access
        service token for `role` is sent."""
        if env == "prod":
            from datatrust.prod.settings import load_env_prod

            load_env_prod()
            url = os.environ.get("DATATRUST_API_URL", "").rstrip("/")
            if not url.startswith("https://"):
                raise RuntimeError(
                    "DATATRUST_API_URL must be the deployed Worker URL "
                    "(https://datatrust.<subdomain>.workers.dev); setup:prod writes it to .env.prod"
                )
            return WorkerClient(url, Auth.service_token(role))
        url = os.environ.get("DATATRUST_API_URL", "http://127.0.0.1:8792").rstrip("/")
        return WorkerClient(url, Auth.local(role))

    def request(self, method: str, path: str, *, json: Any = None, headers: dict[str, str] | None = None):
        url = f"{self.base_url}{path}"
        all_headers = {**self.auth.headers, **(headers or {})}
        last: Exception | None = None
        for attempt in range(self.max_attempts):
            try:
                res = self.session.request(method, url, json=json, headers=all_headers, timeout=self.timeout)
            except requests.RequestException as err:
                last = err
            else:
                if res.status_code < 500:
                    if res.status_code >= 400:
                        raise WorkerHTTPError(res.status_code, path, res.text)
                    return res
                last = WorkerHTTPError(res.status_code, path, res.text)
            if attempt < self.max_attempts - 1:
                self.sleep(self.backoff * (2**attempt))
        assert last is not None
        raise last

    # ------------------------------------------------------------------ runner protocol

    def lease(self, kinds: list[str], target: str, runner_id: str) -> LeasedJob | None:
        res = self.request(
            "POST", "/api/runner/lease", json={"runnerId": runner_id, "kinds": kinds, "target": target}
        )
        if res.status_code == 204:
            return None
        j = res.json()["job"]
        return LeasedJob(j["jobId"], j["runId"], j["kind"], j["payload"], j["leaseToken"], j["attempts"])

    def upload_artifact(self, job: LeasedJob, kind: str, data: Any) -> None:
        self.request(
            "POST",
            f"/api/runner/jobs/{job.job_id}/artifacts",
            json={"kind": kind, "data": data},
            headers=job.headers(),
        )

    def post_lineage(self, job: LeasedJob, events: list[dict[str, Any]]) -> list[str]:
        """POST the build's OpenLineage events in batches of at most 10 events and 256 KB (SPEC 28.5.2)."""
        ids: list[str] = []
        for batch in lineage_batches(events):
            res = self.request("POST", "/api/v1/lineage", json=batch, headers=job.headers())
            ids.extend(res.json()["eventIds"])
        return ids

    def complete(self, job: LeasedJob, body: dict[str, Any]) -> dict[str, Any]:
        return self.request(
            "POST", f"/api/runner/jobs/{job.job_id}/complete", json=body, headers=job.headers()
        ).json()

    # ------------------------------------------------------------------ operator and viewer calls

    def create_run(self, target: str, seed: int, scenario: str | None = None) -> str:
        body: dict[str, Any] = {"target": target, "seed": seed}
        if scenario:
            body["scenario"] = scenario
        return self.request("POST", "/api/runs", json=body).json()["runId"]

    def get_run(self, run_id: str) -> dict[str, Any]:
        return self.request("GET", f"/api/runs/{run_id}").json()

    def get_incident(self, incident_id: str) -> dict[str, Any]:
        return self.request("GET", f"/api/incidents/{incident_id}").json()

    def post_alert(self, alert: dict[str, Any]) -> dict[str, Any]:
        return self.request("POST", "/api/alerts", json=alert).json()

    def whoami(self) -> dict[str, Any]:
        return self.request("GET", "/api/whoami").json()

    def ai_budget(self) -> dict[str, Any]:
        """Today's (UTC) Workers AI neuron ledger and cap (operator role, SPEC 28.5.5)."""
        return self.request("GET", "/api/ai/budget").json()
