"""setup:prod and doctor refuse cleanly and say exactly what is missing (SPEC 18). No cloud calls are made:
the checks below stop at local preconditions."""

from __future__ import annotations

import os
import re
import subprocess

import pytest

from datatrust import config, doctor

SCRIPTS = [
    "setup-prod.sh",
    "doctor.sh",
    "dev-up.sh",
    "dev-down.sh",
    "bench-e2e.sh",
    "prod-wizard.sh",
    "bq-emulator-check.sh",
]


@pytest.mark.parametrize("script", SCRIPTS)
def test_scripts_parse(script):
    subprocess.run(["bash", "-n", str(config.REPO_ROOT / "scripts" / script)], check=True)


def _minimal_path(tmp_path) -> str:
    """A PATH with only the tools setup-prod needs before its Google Cloud preflight (no gcloud, no bq),
    so the test does not depend on whether the machine or CI runner has the Google Cloud CLI."""
    import shutil

    bindir = tmp_path / "bin"
    bindir.mkdir(exist_ok=True)
    for tool in ("bash", "python3", "grep", "sed", "mkdir", "chmod", "cat", "dirname", "env", "tee", "head"):
        found = shutil.which(tool)
        if found and not (bindir / tool).exists():
            (bindir / tool).symlink_to(found)
    return str(bindir)


def _setup(env_file, *args):
    env = {
        "PATH": _minimal_path(env_file.parent),
        "HOME": os.environ.get("HOME", "/tmp"),
        "DATATRUST_ENV_FILE": str(env_file),
    }
    return subprocess.run(
        ["bash", str(config.REPO_ROOT / "scripts" / "setup-prod.sh"), *args],
        capture_output=True,
        text=True,
        env=env,
        cwd=config.REPO_ROOT,
        timeout=60,
    )


def test_setup_needs_env_prod(tmp_path):
    proc = _setup(tmp_path / "missing.env", "--dry-run")
    assert proc.returncode == 1
    assert "cp .env.example .env.prod" in proc.stderr


def test_setup_refuses_a_cloudflare_api_token_in_env_prod(tmp_path):
    env = tmp_path / ".env.prod"
    env.write_text("CLOUDFLARE_API_TOKEN=abc\n")
    proc = _setup(env, "--dry-run")
    assert proc.returncode == 1
    assert "Rename it to DATATRUST_CF_API_TOKEN" in proc.stderr


def test_setup_gcp_names_the_missing_cli(tmp_path):
    env = tmp_path / ".env.prod"
    env.write_text("DATATRUST_GCP_PROJECT=datatrust-abc123\n")
    proc = _setup(env, "--gcp-only", "--dry-run")
    assert proc.returncode == 1
    assert "install the Google Cloud CLI" in proc.stderr


def test_doctor_lists_every_env_prod_value(monkeypatch, tmp_path):
    from datatrust.prod import settings

    monkeypatch.setattr(settings, "ENV_PROD", tmp_path / "none.env")
    for key, _ in doctor.ENV_KEYS:
        monkeypatch.delenv(key, raising=False)
    checks = doctor.env_checks()
    missing = {c.name for c in checks if c.status == "missing"}
    assert ".env.prod" in missing
    assert {k for k, _ in doctor.ENV_KEYS} <= missing
    assert all(c.fix for c in checks if c.status == "missing")


def test_doctor_names_the_gcloud_install_when_absent(monkeypatch, tmp_path):
    monkeypatch.setenv("PATH", _minimal_path(tmp_path))
    checks = doctor.gcp_checks()
    assert checks[0].status == "missing" and "gcloud" in checks[0].fix


def test_doctor_local_checks_shape():
    checks = doctor.local_checks()
    names = {c.name for c in checks}
    assert {"npm ci done", "uv sync done", "DuckDB ICU time zones", "dbt DuckDB session time zone"} <= names
    assert {"port 8792", "port 9242", "port 8160"} <= names
    for c in checks:
        assert c.status in {"ok", "missing", "warn"}
        assert c.line().startswith(f"[{c.status}] ")


def test_wizard_stage_count_and_values_cover_doctor():
    """The wizard's progress counter matches its stages, and it captures every .env.prod value doctor
    requires except DATATRUST_API_URL, which setup:prod writes after the first deploy."""
    import re

    text = (config.REPO_ROOT / "scripts" / "prod-wizard.sh").read_text()
    stages = text.split("# STAGES: author this section", 1)[1]
    declared = int(re.search(r"^TOTAL_STAGES=(\d+)$", stages, re.M).group(1))
    assert declared == len(re.findall(r"^stage ", stages, re.M))
    written = set(re.findall(r"write_env (\w+)", stages))
    assert {k for k, _ in doctor.ENV_KEYS} - written == {"DATATRUST_API_URL"}


def test_setup_prod_never_lets_wrangler_edit_the_committed_config():
    """`wrangler d1 create` and `r2 bucket create` offer (default yes) to patch the wrangler config in the
    current directory, which would write production ids into the committed apps/worker/wrangler.jsonc."""
    import re

    text = (config.REPO_ROOT / "scripts" / "setup-prod.sh").read_text()
    creates = re.findall(r"wr (d1 create|r2 bucket create)[^\n]*", text)
    assert len(creates) == 2
    for line in re.findall(r"wr (?:d1 create|r2 bucket create)[^\n]*", text):
        assert "--update-config=false" in line, line


def test_setup_prod_uses_no_workers_paid_feature():
    """Production runs on the Workers Free plan (SPEC 28): no Basin Pipelines stream, sink or pipeline, and
    exactly the five datatrust-* queues."""
    import re

    text = (config.REPO_ROOT / "scripts" / "setup-prod.sh").read_text()
    commands = [line for line in text.splitlines() if not line.lstrip().startswith("#")]
    assert not any("basin pipelines" in line for line in commands)
    assert "--stream" not in text
    queues = re.search(r"for q in ([^;]+); do", text).group(1).split()
    assert queues == [
        "datatrust-check-results",
        "datatrust-lineage-events",
        "datatrust-investigate",
        "datatrust-audit-events",
        "datatrust-dlq",
    ]
    assert tuple(queues) == doctor.QUEUES


def test_doctor_checks_the_free_plan_config_and_not_pipelines():
    template = (config.REPO_ROOT / "apps" / "worker" / "wrangler.prod.template.jsonc").read_text()
    assert doctor.paid_only_keys(template) == []
    paid = template.replace('  "ai": {', '  "pipelines": [],\n  "limits": {"cpu_ms": 50},\n  "ai": {')
    assert doctor.paid_only_keys(paid) == ["pipelines", "limits"]
    # An allowlist: Paid-only bindings no list named before, and any indentation, are caught too.
    other = template.replace('  "ai": {', '"containers": [], "dispatch_namespaces": [],\n      "ai": {')
    assert doctor.paid_only_keys(other) == ["containers", "dispatch_namespaces"]
    ts = (config.REPO_ROOT / "apps" / "worker" / "test" / "free-plan.test.ts").read_text()
    allow = ts[ts.index("const FREE_PLAN_KEYS = [") : ts.index("];", ts.index("const FREE_PLAN_KEYS = ["))]
    assert sorted(re.findall(r"'([^']+)'", allow)) == sorted(doctor.FREE_PLAN_KEYS)
    source = (config.REPO_ROOT / "pipelines" / "datatrust" / "doctor.py").read_text()
    assert '"pipelines", "streams"' not in source and "Workers Paid plan (manual check)" not in source


def test_wizard_never_asks_for_workers_paid_and_prefills_known_values():
    text = (config.REPO_ROOT / "scripts" / "prod-wizard.sh").read_text()
    stages = text.split("# STAGES: author this section", 1)[1]
    assert "/workers/plans" not in stages and "Workers Paid plan (" not in stages
    assert "Pipelines stream" not in stages
    assert "do not subscribe to Workers Paid" in stages
    for key in (
        "CLOUDFLARE_ACCOUNT_ID",
        "ACCESS_TEAM_DOMAIN",
        "DATATRUST_GCP_PROJECT",
        "DATATRUST_BQ_LOCATION",
    ):
        assert f"prefill {key} " in stages, key
    assert 'KNOWN_ACCESS_TEAM_DOMAIN="https://old-truth-a7dc.cloudflareaccess.com"' in stages
    assert 'KNOWN_GCP_PROJECT="master-magnet-444903-u4"' in stages


def test_doctor_reads_the_workers_ai_budget_with_the_operator_token(monkeypatch):
    from types import SimpleNamespace

    monkeypatch.delenv("CF_ACCESS_OPERATOR_CLIENT_ID", raising=False)
    assert doctor.ai_budget_check("https://w.example").status == "missing"
    monkeypatch.setenv("CF_ACCESS_OPERATOR_CLIENT_ID", "op.access")
    monkeypatch.setenv("CF_ACCESS_OPERATOR_CLIENT_SECRET", "s")
    seen = {}

    def get(url, headers, **_):
        seen.update(url=url, headers=headers)
        body = {"day": "2026-10-11", "reserved": 0, "used": 0, "cap": 2000, "headroom": 2000}
        return SimpleNamespace(status_code=200, json=lambda: body)

    check = doctor.ai_budget_check("https://w.example", get=get)
    assert check.status == "ok" and "headroom 2000" in check.detail
    assert seen["url"] == "https://w.example/api/ai/budget"
    assert seen["headers"]["CF-Access-Client-Id"] == "op.access"
    bad = doctor.ai_budget_check("https://w.example", get=lambda *a, **k: SimpleNamespace(status_code=404))
    assert bad.status == "missing" and "0002_ai_budget" in bad.fix


def test_doctor_known_values_match_the_wizard():
    import re

    text = (config.REPO_ROOT / "scripts" / "prod-wizard.sh").read_text()
    wizard = dict(re.findall(r'^KNOWN_([A-Z_]+)="([^"]*)"$', text, re.M))
    assert wizard == {
        "CLOUDFLARE_ACCOUNT_ID": doctor.KNOWN["CLOUDFLARE_ACCOUNT_ID"],
        "ACCESS_TEAM_DOMAIN": doctor.KNOWN["ACCESS_TEAM_DOMAIN"],
        "GCP_PROJECT": doctor.KNOWN["DATATRUST_GCP_PROJECT"],
        "BQ_LOCATION": doctor.KNOWN["DATATRUST_BQ_LOCATION"],
    }


def test_doctor_reads_adc_through_google_auth_not_the_file(monkeypatch):
    """The doctor asks google-auth for the quota project, like the clients do; it never opens the credentials
    file itself."""
    from types import SimpleNamespace

    import google.auth

    source = (config.REPO_ROOT / "pipelines" / "datatrust" / "doctor.py").read_text()
    assert "application_default_credentials" not in source
    monkeypatch.setattr(google.auth, "default", lambda: (SimpleNamespace(quota_project_id="p-1"), "p-1"))
    assert doctor.adc_quota_project() == (True, "p-1", "types")
    monkeypatch.setattr(google.auth, "default", lambda: (SimpleNamespace(quota_project_id=None), None))
    assert doctor.adc_quota_project()[:2] == (True, None)

    def none():
        from google.auth.exceptions import DefaultCredentialsError

        raise DefaultCredentialsError("Your default credentials were not found.")

    monkeypatch.setattr(google.auth, "default", none)
    assert doctor.adc_quota_project()[:2] == (False, None)


def test_doctor_flags_project_level_roles_beyond_job_user():
    p = "shared-1"
    policy = {
        "bindings": [
            {
                "role": "roles/bigquery.jobUser",
                "members": [f"serviceAccount:datatrust-prober@{p}.iam.gserviceaccount.com"],
            },
            {
                "role": "roles/bigquery.dataViewer",
                "members": [f"serviceAccount:datatrust-analyst@{p}.iam.gserviceaccount.com"],
            },
            {
                "role": "roles/viewer",
                "members": [f"serviceAccount:otherrepo-runner@{p}.iam.gserviceaccount.com"],
            },
            {"role": "roles/owner", "members": ["user:someone@example.com"]},
        ]
    }
    assert doctor.project_role_violations(policy, p) == ["datatrust-analyst roles/bigquery.dataViewer"]
    assert doctor.project_role_violations({}, p) == []


def _fake_gcloud(monkeypatch, *, project="shared-1", billing="False", apis=("bigquery.googleapis.com",)):
    from subprocess import CompletedProcess

    calls = []

    def run(cmd, **_):
        calls.append(cmd)
        joined = " ".join(cmd)
        if joined == "gcloud config get-value account":
            return CompletedProcess(cmd, 0, "operator@example.com\n", "")
        if joined == "gcloud config get-value project":
            return CompletedProcess(cmd, 0, f"{project}\n", "")
        if joined.startswith("gcloud billing projects describe"):
            return CompletedProcess(cmd, 0, f"{billing}\n", "")
        if joined.startswith("gcloud services list"):
            return CompletedProcess(cmd, 0, "\n".join(apis), "")
        if joined.startswith("gcloud projects get-iam-policy"):
            return CompletedProcess(cmd, 0, '{"bindings": []}', "")
        return CompletedProcess(cmd, 1, "", "NOT_FOUND")

    monkeypatch.setattr(doctor, "run", run)
    monkeypatch.setattr(doctor.shutil, "which", lambda tool: f"/usr/bin/{tool}")
    monkeypatch.setattr(doctor, "adc_quota_project", lambda: (True, project, "credentials"))
    return calls


def test_doctor_keeps_checking_google_cloud_before_env_prod_names_the_project(monkeypatch):
    """Without .env.prod the doctor still checks the gcloud project read-only, so everything missing shows up
    in one run: billing, APIs, datasets, service accounts, governance."""
    monkeypatch.delenv("DATATRUST_GCP_PROJECT", raising=False)
    calls = _fake_gcloud(monkeypatch)
    checks = doctor.gcp_checks()
    by_name = {c.name: c for c in checks}
    assert (
        by_name["Google Cloud project"].status == "ok"
        and "gcloud default" in by_name["Google Cloud project"].detail
    )
    assert by_name["billing enabled"].status == "missing"
    assert by_name["APIs datacatalog, bigquerydatapolicy, iam, iamcredentials"].status == "missing"
    assert (
        by_name["datasets datatrust_raw, datatrust_staging, datatrust_marts, datatrust_restricted"].status
        == "missing"
    )
    assert (
        by_name["service accounts datatrust-analyst, datatrust-prober, datatrust-builder"].status == "missing"
    )
    assert by_name["policy tags and masking policies"].status == "missing"
    assert by_name["project-level roles of datatrust-* identities"].status == "ok"
    # read-only: every command is a get, list, show, describe or get-iam-policy
    for cmd in calls:
        assert not any(
            w in cmd for w in ("create", "enable", "mk", "update", "add-iam-policy-binding", "set")
        ), cmd


def test_doctor_names_a_gcloud_project_that_differs_from_env_prod(monkeypatch):
    monkeypatch.setenv("DATATRUST_GCP_PROJECT", "shared-2")
    _fake_gcloud(monkeypatch, project="shared-1")
    checks = {c.name: c for c in doctor.gcp_checks()}
    mismatch = checks["gcloud project matches DATATRUST_GCP_PROJECT"]
    assert mismatch.status == "missing" and mismatch.fix == "gcloud config set project shared-2"


def test_doctor_reports_each_env_prod_value_once(monkeypatch, tmp_path):
    """Cloudflare checks do not repeat the .env.prod values (ACCESS_AUD, service tokens, catalog token), and
    the Access JWKS is checked against the known team before .env.prod names it."""
    from subprocess import CompletedProcess
    from types import SimpleNamespace

    import requests

    for key, _ in doctor.ENV_KEYS:
        monkeypatch.delenv(key, raising=False)
    for key in ("EVIDENCE_HMAC_KEY", "BASIN_CATALOG_URI", "BASIN_WAREHOUSE", "DATATRUST_CF_API_TOKEN"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(doctor, "STATE", tmp_path / "state.json")
    whoami = "│ Someone's Account │ dc93c3bc8aa4f9e09a0d7e7354a80873 │\n"
    outputs = {
        "whoami": whoami,
        "d1": "[]",
        "r2": "Listing buckets...\n",
        "basin": "is not enabled",
        "queues": "",
    }
    monkeypatch.setattr(doctor, "wrangler", lambda *a, **k: CompletedProcess(a, 0, outputs.get(a[0], ""), ""))
    seen = []

    def get(url, **_):
        seen.append(url)
        return SimpleNamespace(ok=True, status_code=200, json=lambda: {"keys": [{}, {}]})

    monkeypatch.setattr(requests, "get", get)
    checks = doctor.cloudflare_checks()
    names = [c.name for c in checks]
    env_names = {key for key, _ in doctor.ENV_KEYS}
    assert not env_names & set(names)
    assert not [n for n in names if n.startswith(".env.prod ") and n != ".env.prod EVIDENCE_HMAC_KEY"]
    assert len(names) == len(set(names))
    by_name = {c.name: c for c in checks}
    assert "dc93c3bc8aa4f9e09a0d7e7354a80873" in by_name["wrangler logged in"].detail
    assert by_name["Access team JWKS"].status == "ok" and "known team" in by_name["Access team JWKS"].detail
    assert seen == ["https://old-truth-a7dc.cloudflareaccess.com/cdn-cgi/access/certs"]
    assert by_name["Basin Catalog REST (pyiceberg)"].detail.startswith("skipped")
    monkeypatch.setenv("CLOUDFLARE_ACCOUNT_ID", "0" * 32)
    wrong = {c.name: c for c in doctor.cloudflare_checks()}
    assert wrong["CLOUDFLARE_ACCOUNT_ID is an account of this login"].status == "missing"


def test_basin_catalog_token_is_scoped_to_the_lake_bucket():
    """The account is shared by four repos: the committer's token reaches datatrust-lake only, never through
    the dashboard's account-wide Admin Read & Write token (2026-10-11 review)."""
    root = config.REPO_ROOT
    for rel in ("scripts/prod-wizard.sh", "scripts/setup-prod.sh", "pipelines/datatrust/doctor.py"):
        assert "Admin Read & Write" not in (root / rel).read_text(), rel
    readme = (root / "README.md").read_text().splitlines()
    readme_step = next(line for line in readme if line.startswith("| 9 |"))
    assert "datatrust-lake" in readme_step and "docs/basin-catalog-token.md" in readme_step
    doc = (root / "docs" / "basin-catalog-token.md").read_text()
    assert "_default_datatrust-lake" in doc
    assert "d229766a2f7f4d299f20eaa8c9b1fde9" in doc and "2efd5506f9c8494dacb1fa10a3e7d5b6" in doc
