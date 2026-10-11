"""Call the bundled TypeScript RCA CLI (`packages/rca/dist/cli.mjs`): one RCA implementation (ADR-0002)."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

from datatrust import config

CLI = config.REPO_ROOT / "packages" / "rca" / "dist" / "cli.mjs"


class RcaCliError(RuntimeError):
    pass


def node_binary() -> str:
    found = shutil.which("node")
    if not found:
        raise RcaCliError("node is not on PATH; install Node 22+ and run `npm ci`")
    return found


def ensure_built() -> Path:
    if not CLI.exists():
        subprocess.run(["npm", "run", "build", "-w", "@datatrust/rca"], cwd=config.REPO_ROOT, check=True)
    return CLI


def rca(command: str, payload: dict[str, Any], *, env_extra: dict[str, str] | None = None) -> Any:
    ensure_built()
    env = dict(os.environ)
    if env_extra:
        env.update(env_extra)
    proc = subprocess.run(
        [node_binary(), str(CLI), command],
        input=json.dumps(payload, default=str),
        capture_output=True,
        text=True,
        env=env,
        check=False,
    )
    if proc.returncode != 0:
        raise RcaCliError(f"rca {command} failed: {proc.stderr.strip()[-2000:]}")
    return json.loads(proc.stdout)
