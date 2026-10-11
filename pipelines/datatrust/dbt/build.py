"""Run dbt (and later dbt-ol) as a subprocess with an isolated target and log path."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from datatrust import config


def _bin(name: str) -> str:
    candidate = Path(sys.executable).parent / name
    return str(candidate) if candidate.exists() else name


@dataclass
class DbtResult:
    returncode: int
    stdout: str
    target_path: Path

    def run_results(self) -> dict[str, Any]:
        return json.loads((self.target_path / "run_results.json").read_text())

    def manifest(self) -> dict[str, Any]:
        return json.loads((self.target_path / "manifest.json").read_text())


def dbt_env(duckdb_path: Path | None = None, extra: dict[str, str] | None = None) -> dict[str, str]:
    env = dict(os.environ)
    env.setdefault("DBT_SEND_ANONYMOUS_USAGE_STATS", "false")
    env["DBT_PROFILES_DIR"] = str(config.DBT_DIR)
    if duckdb_path is not None:
        env["DATATRUST_DUCKDB_PATH"] = str(duckdb_path)
    if extra:
        env.update(extra)
    return env


def run_dbt(
    args: list[str],
    *,
    project_dir: Path = config.DBT_DIR,
    target_path: Path,
    duckdb_path: Path | None = None,
    env_extra: dict[str, str] | None = None,
    executable: str = "dbt",
) -> DbtResult:
    target_path.mkdir(parents=True, exist_ok=True)
    cmd = [
        _bin(executable),
        *args,
        "--project-dir",
        str(project_dir),
        "--profiles-dir",
        str(config.DBT_DIR),
        "--target-path",
        str(target_path),
        "--log-path",
        str(target_path / "logs"),
    ]
    proc = subprocess.run(
        cmd,
        env=dbt_env(duckdb_path, env_extra),
        cwd=str(project_dir),
        capture_output=True,
        text=True,
        check=False,
    )
    return DbtResult(proc.returncode, proc.stdout + proc.stderr, target_path)
