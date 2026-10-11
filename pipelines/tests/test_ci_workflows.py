"""The GitHub Actions workflows parse and name action versions that exist (SPEC 20).

astral-sh/setup-uv has published no floating major tag since v8 (checked with `gh api` on 2026-10-11:
tags v10.0.0 to v10.3.0, no v10), so `@v10` failed every python job with "unable to find version". The
other actions used here (checkout, setup-node, upload-artifact, google-github-actions/auth) do publish
major tags. These tests cannot reach GitHub; they pin the shape that was checked by hand."""

from __future__ import annotations

import re

import pytest
import yaml

from datatrust import config

WORKFLOWS = sorted((config.REPO_ROOT / ".github" / "workflows").glob("*.yml"))
MAJOR_TAGGED = {
    "actions/checkout",
    "actions/setup-node",
    "actions/upload-artifact",
    "google-github-actions/auth",
}
EXACT = re.compile(r"^v\d+\.\d+\.\d+$")


def _steps(path):
    doc = yaml.safe_load(path.read_text())
    for job in doc["jobs"].values():
        yield from job.get("steps", [])


def test_three_workflows_exist():
    assert [p.name for p in WORKFLOWS] == ["ci.yml", "nightly.yml", "prod-runner.yml"]


@pytest.mark.parametrize("path", WORKFLOWS, ids=lambda p: p.name)
def test_every_action_names_a_version_that_exists(path):
    uses = [step["uses"] for step in _steps(path) if "uses" in step]
    assert uses
    for ref in uses:
        action, _, version = ref.partition("@")
        if action == "astral-sh/setup-uv":
            assert EXACT.match(version), f"{ref}: setup-uv has no major tags, pin a release such as v10.3.0"
        else:
            assert action in MAJOR_TAGGED, f"{ref}: check that this action and tag exist, then list it here"
            assert re.match(r"^v\d+$", version), ref


@pytest.mark.parametrize("path", WORKFLOWS, ids=lambda p: p.name)
def test_uv_version_is_pinned_and_the_lockfile_is_honoured(path):
    steps = list(_steps(path))
    setup_uv = [s for s in steps if s.get("uses", "").startswith("astral-sh/setup-uv@")]
    assert setup_uv
    for step in setup_uv:
        assert re.match(r"^\d+\.\d+\.\d+$", str(step["with"]["version"]))
    assert any(s.get("run") == "uv sync --locked" for s in steps)
