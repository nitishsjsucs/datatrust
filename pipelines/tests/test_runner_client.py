"""Runner HTTP client: auth headers, retries on 5xx and network errors, 4xx fatal, lease protocol shape."""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from datatrust.runner.client import Auth, WorkerClient, WorkerHTTPError


class FakeWorker:
    def __init__(self, script):
        self.script = list(script)  # list of (status, body) per request
        self.seen: list[tuple[str, str, dict, object]] = []
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def _handle(self):
                length = int(self.headers.get("content-length") or 0)
                body = json.loads(self.rfile.read(length)) if length else None
                fake.seen.append((self.command, self.path, dict(self.headers), body))
                status, payload = fake.script.pop(0) if fake.script else (500, {"error": "no script"})
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.end_headers()
                if payload is not None:
                    self.wfile.write(json.dumps(payload).encode())

            do_GET = do_POST = _handle

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.server.shutdown()
        self.server.server_close()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.server.server_address[1]}"


def client(url, sleeps=None):
    return WorkerClient(
        url,
        Auth({"Cf-Access-Jwt-Assertion": "t0ken"}),
        sleep=(sleeps.append if sleeps is not None else lambda s: None),
    )


JOB = {
    "jobId": "job_1",
    "runId": "run_1",
    "kind": "dbt_build",
    "payload": {"target": "duckdb"},
    "leaseToken": "abc",
    "attempts": 1,
}


def test_lease_sends_auth_and_parses_job():
    with FakeWorker([(200, {"job": JOB})]) as w:
        job = client(w.url).lease(["dbt_build"], "duckdb", "r1")
    method, path, headers, body = w.seen[0]
    assert (method, path) == ("POST", "/api/runner/lease")
    assert headers["Cf-Access-Jwt-Assertion"] == "t0ken"
    assert body == {"runnerId": "r1", "kinds": ["dbt_build"], "target": "duckdb"}
    assert job and job.job_id == "job_1" and job.lease_token == "abc"


def test_no_job_is_none():
    with FakeWorker([(204, None)]) as w:
        assert client(w.url).lease(["diagnostics"], "duckdb", "r1") is None


def test_retries_5xx_with_exponential_backoff():
    sleeps: list[float] = []
    with FakeWorker([(503, {}), (502, {}), (200, {"job": JOB})]) as w:
        job = client(w.url, sleeps).lease(["dbt_build"], "duckdb", "r1")
    assert job is not None
    assert sleeps == [0.5, 1.0]
    assert len(w.seen) == 3


def test_4xx_is_fatal_without_retry():
    with FakeWorker([(403, {"error": "forbidden"})]) as w:
        with pytest.raises(WorkerHTTPError) as err:
            client(w.url).complete(_job(), {"status": "completed"})
    assert err.value.status == 403
    assert len(w.seen) == 1


def test_job_calls_carry_lease_and_job_headers():
    with FakeWorker(
        [(202, {"accepted": 2, "eventIds": ["a", "b"]}), (202, {"accepted": 1, "eventIds": ["c"]})]
    ) as w:
        ids = client(w.url).post_lineage(_job(), [{"e": 1}, {"e": 2}, {"e": 3}], batch=2)
    assert ids == ["a", "b", "c"]
    for _, path, headers, _ in w.seen:
        assert path == "/api/v1/lineage"
        assert headers["X-DataTrust-Lease-Token"] == "abc"
        assert headers["X-DataTrust-Job-Id"] == "job_1"


def test_network_errors_are_retried_then_raised():
    sleeps: list[float] = []
    c = WorkerClient("http://127.0.0.1:9", Auth({}), max_attempts=3, sleep=sleeps.append, timeout=0.5)
    with pytest.raises(Exception):  # noqa: B017 - requests raises a ConnectionError subclass
        c.whoami()
    assert sleeps == [0.5, 1.0]


def test_service_token_auth(monkeypatch):
    monkeypatch.setenv("CF_ACCESS_CLIENT_ID", "id.access")
    monkeypatch.setenv("CF_ACCESS_CLIENT_SECRET", "s3cret")
    assert Auth.service_token().headers == {
        "CF-Access-Client-Id": "id.access",
        "CF-Access-Client-Secret": "s3cret",
    }
    monkeypatch.delenv("CF_ACCESS_CLIENT_SECRET")
    with pytest.raises(RuntimeError):
        Auth.service_token()


def _job():
    from datatrust.runner.client import LeasedJob

    return LeasedJob("job_1", "run_1", "dbt_build", {}, "abc", 1)
