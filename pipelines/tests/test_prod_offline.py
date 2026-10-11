"""Production path pieces that can be checked without credentials (SPEC 17, 18). Nothing here talks to
Google Cloud or Cloudflare: fakes stand in for the clients, so these tests prove our logic (idempotency,
dry runs, placeholders, type checks), not the services."""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from datatrust import config
from datatrust.load.bigquery_loader import check_schema
from datatrust.prod import governance, settings
from datatrust.prod.settings import GcpSettings, NotConfigured
from datatrust.warehouse.bigquery_wh import BigQueryWarehouse
from datatrust.warehouse.readonly import ReadOnlyViolation

# ------------------------------------------------------------------------------- wrangler prod template


def _jsonc(text: str) -> dict:
    return json.loads("\n".join(line for line in text.splitlines() if not line.lstrip().startswith("//")))


def test_prod_template_renders_with_ai_pipelines_and_no_cron(tmp_path):
    out = config.REPO_ROOT / "apps" / "worker" / "wrangler.prod.jsonc"
    try:
        subprocess.run(
            ["node", "scripts/render-prod-config.mjs", "--placeholders"], cwd=config.REPO_ROOT, check=True
        )
        cfg = _jsonc(out.read_text())
    finally:
        out.unlink(missing_ok=True)
    assert cfg["vars"]["ENVIRONMENT"] == "production"
    assert cfg["vars"]["ACCESS_MODE"] == "cloudflare"
    assert cfg["vars"]["SUMMARIZER"] == "workers-ai"
    assert cfg["vars"]["ACCESS_TEAM_DOMAIN"] == "https://unset.cloudflareaccess.com"
    assert cfg["ai"] == {"binding": "AI"}
    assert cfg["pipelines"][0]["binding"] == "EVENTS"
    assert cfg["workers_dev"] is True and cfg["preview_urls"] is False
    assert "triggers" not in cfg
    local = _jsonc((config.REPO_ROOT / "apps" / "worker" / "wrangler.jsonc").read_text())
    assert cfg["queues"] == local["queues"] and cfg["workflows"] == local["workflows"]


def test_prod_template_renderer_rejects_bad_values():
    proc = subprocess.run(
        ["node", "scripts/render-prod-config.mjs", "--d1", "nope", "--stream", "x"],
        cwd=config.REPO_ROOT,
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 2
    assert "--d1 must be the D1 database id" in proc.stderr


# ------------------------------------------------------------------------------- settings and placeholders


def test_refuses_missing_or_placeholder_project(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "ENV_PROD", tmp_path / ".env.prod")
    monkeypatch.delenv("DATATRUST_GCP_PROJECT", raising=False)
    with pytest.raises(NotConfigured, match="DATATRUST_GCP_PROJECT"):
        GcpSettings.from_env()
    monkeypatch.setenv("DATATRUST_GCP_PROJECT", "datatrust-ci-placeholder")
    with pytest.raises(NotConfigured):
        GcpSettings.from_env()
    monkeypatch.setenv("DATATRUST_GCP_PROJECT", "datatrust-abc123")
    s = GcpSettings.from_env()
    assert s.prober_sa == "datatrust-prober@datatrust-abc123.iam.gserviceaccount.com"


def test_env_prod_is_parsed_without_overriding_the_shell(monkeypatch, tmp_path):
    env = tmp_path / ".env.prod"
    env.write_text("# comment\nDATATRUST_BQ_LOCATION='EU'\nDATATRUST_GCP_PROJECT=from-file\nEMPTY=\n")
    monkeypatch.setenv("DATATRUST_GCP_PROJECT", "from-shell")
    monkeypatch.delenv("DATATRUST_BQ_LOCATION", raising=False)
    values = settings.load_env_prod(env)
    assert values["DATATRUST_BQ_LOCATION"] == "EU"
    import os

    assert os.environ["DATATRUST_GCP_PROJECT"] == "from-shell"
    assert os.environ["DATATRUST_BQ_LOCATION"] == "EU"


def test_refuses_placeholder_policy_tags(monkeypatch, tmp_path):
    path = tmp_path / "dbt_vars.yml"
    monkeypatch.setattr(settings, "DBT_VARS", path)
    with pytest.raises(NotConfigured, match="governance apply"):
        settings.dbt_vars()
    path.write_text("pt_pii_string: projects/placeholder/locations/us/taxonomies/0/policyTags/0\n")
    with pytest.raises(NotConfigured, match="placeholders"):
        settings.dbt_vars()
    path.write_text("pt_pii_string: projects/p/locations/us/taxonomies/1/policyTags/2\n")
    assert settings.dbt_vars() == {"pt_pii_string": "projects/p/locations/us/taxonomies/1/policyTags/2"}


# ------------------------------------------------------------------------------- BigQuery probes


class FakeJob:
    def __init__(self, rows, processed=123, billed=10):
        self._rows, self.total_bytes_processed, self.total_bytes_billed = rows, processed, billed

    def result(self, max_results=None):
        return [SimpleNamespace(items=lambda r=r: r.items()) for r in self._rows]


class FakeBQ:
    def __init__(self, rows):
        self.rows, self.calls = rows, []

    def query(self, sql, job_config=None, location=None):
        self.calls.append(
            (sql, job_config.dry_run, job_config.maximum_bytes_billed, job_config.query_parameters)
        )
        return FakeJob([] if job_config.dry_run else self.rows)


def test_bigquery_probe_dry_runs_first_with_a_byte_cap():
    fake = FakeBQ([{"n_rows": 10, "n_null": 0}])
    wh = BigQueryWarehouse("my-project", "US", client=fake)
    assert wh.query("select count(*) as n_rows from `my-project.datatrust_marts.dim_employee`") == [
        {"n_rows": 10, "n_null": 0}
    ]
    (sql1, dry1, cap1, _), (_, dry2, cap2, _) = fake.calls
    assert (dry1, dry2) == (True, False)
    assert cap1 == cap2 == 100 * 1000 * 1000
    assert wh.bytes_dry_run == 123 and wh.bytes_billed == 10
    with pytest.raises(ReadOnlyViolation):
        wh.query("delete from `my-project.datatrust_raw.hires` where true")
    assert len(fake.calls) == 2


def test_bigquery_relation_columns_use_a_query_parameter():
    fake = FakeBQ([{"column_name": "employee_id"}])
    wh = BigQueryWarehouse("my-project", "US", client=fake)
    assert wh.relation_columns({"schema": "datatrust_marts", "identifier": "dim_employee"}) == {"employee_id"}
    sql, _, _, params = fake.calls[-1]
    assert "INFORMATION_SCHEMA.COLUMNS" in sql and "dim_employee" not in sql
    assert params[0].name == "table_name" and params[0].value == "dim_employee"


def test_loaded_bigquery_types_are_checked():
    ok = [("employee_id", "INTEGER"), ("hire_date", "DATE"), ("termination_date", "DATE")]
    assert check_schema("employees", ok) == []
    bad = check_schema("stage_events", [("entered_at", "DATETIME")])
    assert any("TIMESTAMP" in p for p in bad)
    assert check_schema("fx_rates", [("rate_to_usd", "FLOAT")]) == [
        "fx_rates.rate_to_usd: loaded as FLOAT, expected ['NUMERIC']"
    ]


# ------------------------------------------------------------------------------- governance


class FakeIam:
    def __init__(self):
        self.policies: dict[str, object] = {}
        self.sets = 0

    def get_iam_policy(self, request):
        from google.iam.v1 import policy_pb2

        return self.policies.setdefault(request["resource"], policy_pb2.Policy())

    def set_iam_policy(self, request):
        self.sets += 1
        self.policies[request["resource"]] = request["policy"]
        return request["policy"]


class FakePTM(FakeIam):
    def __init__(self):
        super().__init__()
        self.taxonomies, self.tags = [], {}

    def list_taxonomies(self, parent):
        return list(self.taxonomies)

    def create_taxonomy(self, parent, taxonomy):
        t = SimpleNamespace(
            name=f"{parent}/taxonomies/{len(self.taxonomies) + 1}", display_name=taxonomy.display_name
        )
        self.taxonomies.append(t)
        return t

    def list_policy_tags(self, parent):
        return list(self.tags.values())

    def create_policy_tag(self, parent, policy_tag):
        t = SimpleNamespace(
            name=f"{parent}/policyTags/{len(self.tags) + 1}", display_name=policy_tag.display_name
        )
        self.tags[policy_tag.display_name] = t
        return t


class FakeDPS(FakeIam):
    def __init__(self):
        super().__init__()
        self.created = {}

    def get_data_policy(self, name):
        from google.api_core.exceptions import NotFound

        if name not in self.created:
            raise NotFound(name)
        return self.created[name]

    def create_data_policy(self, parent, data_policy):
        self.created[f"{parent}/dataPolicies/{data_policy.data_policy_id}"] = data_policy
        return data_policy


class FakeDatasets:
    def __init__(self):
        self.datasets, self.updates = {}, 0

    def get_dataset(self, ref):
        return self.datasets.setdefault(ref, SimpleNamespace(access_entries=[]))

    def update_dataset(self, ds, fields):
        self.updates += 1
        return ds


def test_governance_apply_is_idempotent(monkeypatch, tmp_path):
    monkeypatch.setattr(governance, "DBT_VARS", tmp_path / "dbt_vars.yml")
    monkeypatch.setattr(governance, "PROD_DIR", tmp_path)
    s = GcpSettings(
        "datatrust-abc123", "US", "prober@x.iam.gserviceaccount.com", "analyst@x.iam.gserviceaccount.com"
    )
    ptm, dps, bq = FakePTM(), FakeDPS(), FakeDatasets()
    first = governance.apply(s, "nitish@example.com", ptm=ptm, dps=dps, bq=bq)
    assert first.taxonomy.startswith("projects/datatrust-abc123/locations/us/taxonomies/")
    assert set(first.tags) == {"pii_string", "pii_date", "compensation"}
    rules = {k: v.data_masking_policy.predefined_expression.name for k, v in dps.created.items()}
    assert sorted(rules.values()) == ["ALWAYS_NULL", "DATE_YEAR_MASK", "SHA256"]
    # Each masking rule is bound to its policy tag. Only the v1 API can set that binding (in v2 `policy_tag`
    # is output only), so an unbound v2 policy would leave tagged columns denied instead of masked.
    from google.cloud import bigquery_datapolicies_v1

    for key, tag in first.tags.items():
        policy = dps.created[first.data_policies[key]]
        assert isinstance(policy, bigquery_datapolicies_v1.DataPolicy)
        assert policy.policy_tag == tag and policy.data_policy_id == f"datatrust_{key}"
    assert ptm.sets == 3 and dps.sets == 3 and bq.updates == 4
    members = list(ptm.policies[first.tags["pii_string"]].bindings[0].members)
    assert members == ["user:nitish@example.com", "serviceAccount:prober@x.iam.gserviceaccount.com"]
    vars_text = (tmp_path / "dbt_vars.yml").read_text()
    assert re.search(
        r"pt_pii_string: projects/datatrust-abc123/locations/us/taxonomies/1/policyTags/\d", vars_text
    )

    second = governance.apply(s, "nitish@example.com", ptm=ptm, dps=dps, bq=bq)
    assert second.created == []
    assert ptm.sets == 3 and dps.sets == 3 and bq.updates == 4
    assert second.tags == first.tags


def test_governance_refuses_a_data_policy_bound_to_another_tag(monkeypatch, tmp_path):
    monkeypatch.setattr(governance, "DBT_VARS", tmp_path / "dbt_vars.yml")
    monkeypatch.setattr(governance, "PROD_DIR", tmp_path)
    s = GcpSettings("datatrust-abc123", "US", "p@x.iam.gserviceaccount.com", "a@x.iam.gserviceaccount.com")
    ptm, dps, bq = FakePTM(), FakeDPS(), FakeDatasets()
    state = governance.apply(s, "nitish@example.com", ptm=ptm, dps=dps, bq=bq)
    dps.created[state.data_policies["pii_date"]].policy_tag = state.tags["compensation"]
    with pytest.raises(RuntimeError, match="bound to"):
        governance.apply(s, "nitish@example.com", ptm=ptm, dps=dps, bq=bq)


def test_governance_verify_retries_through_propagation(monkeypatch):
    s = GcpSettings("datatrust-abc123", "US", "p@x", "a@x")
    calls = {"n": 0}

    def flaky(bq):
        calls["n"] += 1
        if calls["n"] < 3:
            raise AssertionError("not hashed yet")

    monkeypatch.setattr(governance, "_assertions", lambda project: [governance.Assertion("hashed", flaky)])
    sleeps: list[float] = []
    out = governance.verify(s, bq=object(), sleep=sleeps.append)
    assert out == [{"assertion": "hashed", "ok": True, "attempts": 3, "error": None}]
    assert sleeps == [10.0, 20.0]


def test_governance_verify_reports_the_assertion_still_failing(monkeypatch):
    s = GcpSettings("datatrust-abc123", "US", "p@x", "a@x")

    def never(bq):
        raise AssertionError("analyst can read datatrust_staging")

    monkeypatch.setattr(
        governance, "_assertions", lambda project: [governance.Assertion("staging denied", never)]
    )
    out = governance.verify(s, bq=object(), sleep=lambda _: None, budget_seconds=60)
    assert out[0]["ok"] is False and "datatrust_staging" in out[0]["error"]
    assert Path(__file__).exists()


# ------------------------------------------------------------------------------- Worker secrets and roles


def _secret_env(**extra):
    return {"EVIDENCE_HMAC_KEY": "k" * 64, **extra}


def test_worker_secrets_give_each_principal_least_privilege():
    from datatrust.prod.worker_secrets import worker_secrets

    out = worker_secrets(
        _secret_env(
            DATATRUST_OPERATOR_EMAIL="Nitish@Example.com",
            CF_ACCESS_CLIENT_ID="Runner.access",
            CF_ACCESS_OPERATOR_CLIENT_ID="operator.access",
            ACCESS_AUD="aud-tag",
        )
    )
    roles = json.loads(out["ROLE_MAP_JSON"])
    assert roles == {
        "emails": {"nitish@example.com": ["operator", "viewer"]},
        "serviceTokens": {"runner.access": ["runner"], "operator.access": ["operator", "viewer"]},
    }
    assert out["ACCESS_AUD"] == "aud-tag" and out["EVIDENCE_HMAC_KEY"] == "k" * 64


def test_worker_secrets_fail_closed_and_refuse_a_shared_token(tmp_path):
    from datatrust.prod.worker_secrets import worker_secrets, write_worker_secrets

    assert worker_secrets(_secret_env())["ACCESS_AUD"] == "unset"
    with pytest.raises(ValueError, match="EVIDENCE_HMAC_KEY"):
        worker_secrets({})
    with pytest.raises(ValueError, match="second service token"):
        worker_secrets(
            _secret_env(CF_ACCESS_CLIENT_ID="same.access", CF_ACCESS_OPERATOR_CLIENT_ID="SAME.access")
        )
    path = tmp_path / "prod" / "secrets.json"
    write_worker_secrets(path, _secret_env())
    assert path.stat().st_mode & 0o777 == 0o600
    assert set(json.loads(path.read_text())) == {"EVIDENCE_HMAC_KEY", "ROLE_MAP_JSON", "ACCESS_AUD"}


def test_prod_clients_use_the_token_for_their_role(monkeypatch, tmp_path):
    from datatrust.runner.client import Auth, WorkerClient

    monkeypatch.setattr(settings, "ENV_PROD", tmp_path / ".env.prod")
    (tmp_path / ".env.prod").write_text(
        "DATATRUST_API_URL=https://datatrust.example.workers.dev/\n"
        "CF_ACCESS_CLIENT_ID=runner.access\nCF_ACCESS_CLIENT_SECRET=r\n"
        "CF_ACCESS_OPERATOR_CLIENT_ID=operator.access\nCF_ACCESS_OPERATOR_CLIENT_SECRET=o\n"
    )
    for k in (
        "DATATRUST_API_URL",
        "CF_ACCESS_CLIENT_ID",
        "CF_ACCESS_CLIENT_SECRET",
        "CF_ACCESS_OPERATOR_CLIENT_ID",
        "CF_ACCESS_OPERATOR_CLIENT_SECRET",
    ):
        monkeypatch.delenv(k, raising=False)
    runner = WorkerClient.from_env("runner", "prod")
    ops = WorkerClient.from_env("operator", "prod")
    assert runner.base_url == ops.base_url == "https://datatrust.example.workers.dev"
    assert runner.auth.headers["CF-Access-Client-Id"] == "runner.access"
    assert ops.auth.headers["CF-Access-Client-Id"] == "operator.access"
    monkeypatch.delenv("CF_ACCESS_OPERATOR_CLIENT_SECRET")
    with pytest.raises(RuntimeError, match="datatrust-operator"):
        Auth.service_token("operator")


def test_prod_client_refuses_the_local_default_url(monkeypatch, tmp_path):
    from datatrust.runner.client import WorkerClient

    monkeypatch.setattr(settings, "ENV_PROD", tmp_path / "none.env")
    monkeypatch.delenv("DATATRUST_API_URL", raising=False)
    with pytest.raises(RuntimeError, match="DATATRUST_API_URL"):
        WorkerClient.from_env("runner", "prod")
    monkeypatch.setenv("DATATRUST_API_URL", "http://127.0.0.1:8792")
    with pytest.raises(RuntimeError, match="DATATRUST_API_URL"):
        WorkerClient.from_env("runner", "prod")


def test_doctor_checks_each_service_token_role(monkeypatch):
    from datatrust import doctor

    monkeypatch.setenv("CF_ACCESS_CLIENT_ID", "runner.access")
    monkeypatch.setenv("CF_ACCESS_CLIENT_SECRET", "r")
    monkeypatch.setenv("CF_ACCESS_OPERATOR_CLIENT_ID", "operator.access")
    monkeypatch.setenv("CF_ACCESS_OPERATOR_CLIENT_SECRET", "o")
    roles = {"runner.access": ["runner"], "operator.access": ["runner"]}

    def fake_get(url, headers, **_):
        cid = headers["CF-Access-Client-Id"]
        return SimpleNamespace(
            status_code=200, json=lambda: {"kind": "service", "id": cid, "roles": roles[cid]}
        )

    checks = doctor.service_token_checks("https://w", get=fake_get)
    assert [c.status for c in checks] == ["ok", "missing"]
    assert "expected ['operator', 'viewer']" in checks[1].detail
    denied = doctor.service_token_checks("https://w", get=lambda *a, **k: SimpleNamespace(status_code=403))
    assert all(c.status == "missing" and "ROLE_MAP_JSON" in c.fix for c in denied)


def test_smoke_stops_when_the_runner_thread_dies():
    from datatrust.prod.smoke import RunnerThread, wait_for_run

    runner = RunnerThread(client=None)
    runner.error = PermissionError("403 from /api/runner/lease")
    ops = SimpleNamespace(get_run=lambda run_id: {"status": "running"})
    with pytest.raises(RuntimeError, match="runner stopped: PermissionError"):
        wait_for_run(ops, "run_1", runner, timeout_s=5)


def test_setup_prod_deploy_url_parser_reads_wrangler_output(tmp_path):
    """setup-prod reads the workers.dev URL from WRANGLER_OUTPUT_FILE_PATH (deploy output stays on the
    terminal so wrangler can prompt for a workers.dev subdomain on a new account)."""
    script = (config.REPO_ROOT / "scripts" / "setup-prod.sh").read_text()
    parser = script.split("<<'PY2'\n", 1)[1].split("\nPY2\n", 1)[0]
    out = tmp_path / "wrangler-deploy.ndjson"
    out.write_text(
        json.dumps({"type": "wrangler-session", "version": 1})
        + "\n"
        + json.dumps(
            {
                "type": "deploy",
                "targets": ["https://datatrust.nitish.workers.dev", "Consumer for dt-check-results"],
            }
        )
        + "\n"
    )
    run = subprocess.run(["python3", "-c", parser, str(out)], capture_output=True, text=True, check=True)
    assert run.stdout.strip() == "https://datatrust.nitish.workers.dev"
    missing = subprocess.run(
        ["python3", "-c", parser, str(tmp_path / "none")], capture_output=True, text=True, check=True
    )
    assert missing.stdout.strip() == ""


ENABLED_CATALOG = (
    "Getting Basin Catalog status for 'datatrust-lake'...\n\n"
    "\x1b[37mCatalog URI:\x1b[39m  \x1b[90mhttps://catalog.cloudflarestorage.com/0123abcd/datatrust-lake\x1b[39m\n"
    "\x1b[37mWarehouse:\x1b[39m    \x1b[90m0123abcd_datatrust-lake\x1b[39m\n"
    "\x1b[37mStatus:\x1b[39m       \x1b[90mactive\x1b[39m\n"
)
# Message printed by wrangler 4.149 when the catalog is off (it contains the word "enabled").
DISABLED_CATALOG = (
    "Getting Basin Catalog status for 'datatrust-lake'...\n\n"
    "Basin Catalog is not enabled for bucket 'datatrust-lake'. Please use 'wrangler basin catalog enable "
    "datatrust-lake' to first enable Basin Catalog on this bucket.\n"
)


def test_catalog_status_parsers_do_not_mistake_not_enabled_for_enabled():
    from datatrust import doctor

    assert doctor.catalog_enabled(0, ENABLED_CATALOG)
    assert not doctor.catalog_enabled(0, DISABLED_CATALOG)
    script = (config.REPO_ROOT / "scripts" / "setup-prod.sh").read_text()
    parser = script.split("<<'PYCAT'\n", 1)[1].split("\nPYCAT\n", 1)[0]

    def parse(text):
        return subprocess.run(
            ["python3", "-c", parser], input=text, capture_output=True, text=True, check=True
        ).stdout.strip()

    assert parse(ENABLED_CATALOG) == (
        "0123abcd_datatrust-lake https://catalog.cloudflarestorage.com/0123abcd/datatrust-lake"
    )
    assert parse(DISABLED_CATALOG) == ""
