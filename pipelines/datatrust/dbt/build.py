"""Run dbt and dbt-ol as subprocesses with isolated target and log paths; collect artifacts (SPEC 9, 14.2).

`build_with_lineage` runs `dbt-ol build` with a file transport, so OpenLineage events (column lineage
facets on model outputs, data quality assertions on tests) land in `<target>/openlineage.jsonl`, and
writes `<target>/relations.json`, which maps dbt relations to unique ids with checksums, column
classifications and model meta. OpenLineage dataset names embed the absolute DuckDB path, so the
lineage graph resolves datasets by (schema, table) against relations.json, never by namespace.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from datatrust import config

PROJECT = "datatrust"


def _bin_dir() -> Path:
    return Path(sys.executable).parent


def _bin(name: str) -> str:
    candidate = _bin_dir() / name
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

    def openlineage_events(self) -> list[dict[str, Any]]:
        path = self.target_path / "openlineage.jsonl"
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def dbt_env(duckdb_path: Path | None = None, extra: dict[str, str] | None = None) -> dict[str, str]:
    env = dict(os.environ)
    env.setdefault("DBT_SEND_ANONYMOUS_USAGE_STATS", "false")
    env["DBT_PROFILES_DIR"] = str(config.DBT_DIR)
    # dbt-ol starts `dbt` from PATH; make sure it is this environment's dbt.
    env["PATH"] = str(_bin_dir()) + os.pathsep + env.get("PATH", "")
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


def build_with_lineage(
    *,
    project_dir: Path = config.DBT_DIR,
    target_path: Path,
    duckdb_path: Path | None = None,
    env_extra: dict[str, str] | None = None,
    extra_args: list[str] | None = None,
) -> DbtResult:
    """`dbt-ol build` with a file transport; writes openlineage.jsonl and relations.json into target_path."""
    target_path.mkdir(parents=True, exist_ok=True)
    events_path = target_path / "openlineage.jsonl"
    if events_path.exists():
        events_path.unlink()
    ol_config = target_path / "openlineage.yml"
    ol_config.write_text(
        "transport:\n"
        "  type: file\n"
        f"  log_file_path: {json.dumps(str(events_path))}\n"
        "  append: true\n"
    )
    env = {"OPENLINEAGE_CONFIG": str(ol_config), "OPENLINEAGE_NAMESPACE": "datatrust"}
    if env_extra:
        env.update(env_extra)
    res = run_dbt(
        ["build", *(extra_args or [])],
        project_dir=project_dir,
        target_path=target_path,
        duckdb_path=duckdb_path,
        env_extra=env,
        executable="dbt-ol",
    )
    if (target_path / "manifest.json").exists():
        rel = relations_map(res.manifest())
        (target_path / "relations.json").write_text(json.dumps(rel, indent=1, sort_keys=True) + "\n")
    return res


def _columns(node: dict[str, Any]) -> dict[str, dict[str, Any]]:
    out = {}
    for name, col in (node.get("columns") or {}).items():
        meta = col.get("meta") or {}
        out[name] = {
            "classification": meta.get("classification", "internal"),
            "entity": meta.get("entity"),
            "dataType": col.get("data_type"),
        }
    return out


def relations_map(manifest: dict[str, Any], dialect: str | None = None) -> dict[str, Any]:
    """dbt relations -> unique ids with checksum, materialization, classified columns and model meta."""
    adapter = dialect or manifest.get("metadata", {}).get("adapter_type", "duckdb")
    nodes: dict[str, Any] = {}
    for uid, src in manifest.get("sources", {}).items():
        nodes[uid] = {
            "uniqueId": uid,
            "kind": "source",
            "name": src["name"],
            "database": src.get("database"),
            "schema": src["schema"],
            "identifier": src.get("identifier") or src["name"],
            "relation": src.get("relation_name"),
            "checksum": None,
            "materialization": None,
            "columns": _columns(src),
            "meta": src.get("meta") or {},
        }
    for uid, node in manifest.get("nodes", {}).items():
        if node["resource_type"] != "model":
            continue
        checksum = node.get("checksum") or {}
        nodes[uid] = {
            "uniqueId": uid,
            "kind": "model",
            "name": node["name"],
            "database": node.get("database"),
            "schema": node["schema"],
            "identifier": node.get("alias") or node["name"],
            "relation": node.get("relation_name"),
            "checksum": checksum.get("checksum"),
            "materialization": (node.get("config") or {}).get("materialized"),
            "columns": _columns(node),
            "meta": (node.get("config") or {}).get("meta") or node.get("meta") or {},
        }
    return {"project": PROJECT, "dialect": adapter, "nodes": nodes}
