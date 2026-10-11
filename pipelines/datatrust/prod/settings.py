"""Production settings: .env.prod, placeholders that must never reach BigQuery, .prod/ state files."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path

import yaml

from datatrust import config

ENV_PROD = Path(os.environ.get("DATATRUST_ENV_FILE", config.REPO_ROOT / ".env.prod"))
PROD_DIR = config.REPO_ROOT / ".prod"
DBT_VARS = PROD_DIR / "dbt_vars.yml"
PLACEHOLDER_PROJECT = "datatrust-ci-placeholder"
PLACEHOLDER_TAG = re.compile(r"projects/placeholder/")
DATASETS = ("datatrust_raw", "datatrust_staging", "datatrust_marts", "datatrust_restricted")


class NotConfigured(RuntimeError):
    """A production prerequisite is missing; the message says exactly what to do."""


def load_env_prod(path: Path = ENV_PROD) -> dict[str, str]:
    """Parse KEY=VALUE lines (quotes stripped) into os.environ without overriding what is already set."""
    values: dict[str, str] = {}
    if path.exists():
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip("'\"")
    for k, v in values.items():
        if v:
            os.environ.setdefault(k, v)
    return values


@dataclass(frozen=True)
class GcpSettings:
    project: str
    location: str
    prober_sa: str
    analyst_sa: str

    @staticmethod
    def from_env() -> GcpSettings:
        load_env_prod()
        project = os.environ.get("DATATRUST_GCP_PROJECT", "")
        if not project or project == PLACEHOLDER_PROJECT:
            raise NotConfigured(
                "DATATRUST_GCP_PROJECT is not set (or is the CI placeholder): "
                "set it in .env.prod (README, Google Cloud)"
            )
        location = os.environ.get("DATATRUST_BQ_LOCATION", "US")
        prober = (
            os.environ.get("DATATRUST_PROBER_SA") or f"datatrust-prober@{project}.iam.gserviceaccount.com"
        )
        analyst = f"datatrust-analyst@{project}.iam.gserviceaccount.com"
        return GcpSettings(project, location, prober, analyst)


def dbt_vars() -> dict[str, str]:
    if not DBT_VARS.exists():
        raise NotConfigured(".prod/dbt_vars.yml is missing: run `uv run datatrust prod governance apply`")
    data = yaml.safe_load(DBT_VARS.read_text()) or {}
    bad = [k for k, v in data.items() if k.startswith("pt_") and PLACEHOLDER_TAG.search(str(v))]
    if bad or not any(k.startswith("pt_") for k in data):
        raise NotConfigured(f"policy-tag vars still placeholders in .prod/dbt_vars.yml: {bad or 'none set'}")
    return {k: str(v) for k, v in data.items()}


def dbt_vars_arg() -> str:
    return yaml.safe_dump(dbt_vars(), default_flow_style=True).strip()
