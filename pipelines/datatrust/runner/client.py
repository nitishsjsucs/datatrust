"""Worker API client for the runner (SPEC 13.1, 14.2, 15).

Local: an Access-style dev JWT in `Cf-Access-Jwt-Assertion` (DATATRUST_DEV_TOKEN, or minted with
`node scripts/dev-token.mjs`). Production: the Access service token headers `CF-Access-Client-Id` and
`CF-Access-Client-Secret`; Cloudflare Access turns them into the JWT the Worker verifies.
Retries with exponential backoff on 5xx and network errors; 4xx responses are fatal.
"""

from __future__ import annotations

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
    def service_token() -> Auth:
        cid, secret = os.environ.get("CF_ACCESS_CLIENT_ID"), os.environ.get("CF_ACCESS_CLIENT_SECRET")
        if not cid or not secret:
            raise RuntimeError("CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET are required for --env prod")
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
        url = os.environ.get("DATATRUST_API_URL", "http://127.0.0.1:8792").rstrip("/")
        auth = Auth.service_token() if env == "prod" else Auth.local(role)
        return WorkerClient(url, auth)

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

    def post_lineage(self, job: LeasedJob, events: list[dict[str, Any]], batch: int = 50) -> list[str]:
        ids: list[str] = []
        for i in range(0, len(events), batch):
            res = self.request("POST", "/api/v1/lineage", json=events[i : i + batch], headers=job.headers())
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
