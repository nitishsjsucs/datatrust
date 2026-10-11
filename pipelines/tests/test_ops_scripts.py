"""setup:prod and doctor refuse cleanly and say exactly what is missing (SPEC 18). No cloud calls are made:
the checks below stop at local preconditions."""

from __future__ import annotations

import os
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
