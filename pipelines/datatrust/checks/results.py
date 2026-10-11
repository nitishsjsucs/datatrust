"""dbt `run_results.json` + `manifest.json` -> CheckResult list (SPEC 7.2, 13.1).

Data tests map to the registry's check ids. A model that fails its enforced contract becomes a
`schema_contract` result naming the mismatched columns; any other model error becomes `model_error`.
Row values never appear in a CheckResult: only counts, node ids, column names and dbt's message.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from typing import Any

from datatrust.checks.registry import Registry
from datatrust.checks.registry import load as load_registry

CONTRACT_MARKER = "This model has an enforced contract that failed"
_TABLE_ROW = re.compile(r"^\s*\|\s*([A-Za-z_][A-Za-z0-9_]*)\s*\|\s*([^|]*)\|\s*([^|]*)\|\s*([^|]*)\|\s*$")

STATUS_MAP = {
    "pass": "pass",
    "success": "pass",
    "fail": "fail",
    "warn": "fail",
    "error": "error",
    "runtime error": "error",
    "skipped": "skip",
    "skip": "skip",
}


@dataclass
class CheckResult:
    checkId: str
    testName: str
    category: str
    kind: str  # data_test | schema_contract | model_error
    status: str  # pass | fail | error | skip
    failures: int
    node: str
    columns: list[str] = field(default_factory=list)
    message: str | None = None

    def to_json(self) -> dict[str, Any]:
        return asdict(self)


def contract_columns(message: str) -> list[str]:
    """Column names from dbt's contract mismatch table (header and separator rows skipped)."""
    cols = []
    for line in message.splitlines():
        m = _TABLE_ROW.match(line)
        if not m or m.group(1) == "column_name" or set(m.group(2).strip()) <= {"-"}:
            continue
        cols.append(m.group(1))
    return cols


def _short(message: str | None, limit: int = 2000) -> str | None:
    if message is None:
        return None
    return message if len(message) <= limit else message[:limit] + "..."


def classify(
    run_results: dict[str, Any], manifest: dict[str, Any], registry: Registry | None = None
) -> list[CheckResult]:
    registry = registry or load_registry()
    by_test = registry.by_test()
    nodes = manifest["nodes"]
    out: list[CheckResult] = []
    for res in run_results["results"]:
        uid = res["unique_id"]
        node = nodes.get(uid)
        if node is None:
            continue
        status = STATUS_MAP.get(str(res["status"]).lower(), "error")
        message = res.get("message")
        if node["resource_type"] == "test":
            check = by_test.get(node["name"])
            if check is None:
                raise ValueError(f"test {node['name']} is not in checks/registry.yml")
            failures = res.get("failures")
            out.append(
                CheckResult(
                    checkId=check.id,
                    testName=check.test,
                    category=check.category,
                    kind="data_test",
                    status=status,
                    failures=int(failures) if failures is not None and status != "error" else 0,
                    node=check.node,
                    columns=list(check.columns),
                    message=_short(message) if status in ("fail", "error") else None,
                )
            )
        elif node["resource_type"] == "model" and status == "error":
            text = message or ""
            if CONTRACT_MARKER in text:
                kind, cols = "schema_contract", contract_columns(text)
            else:
                kind, cols = "model_error", []
            out.append(
                CheckResult(
                    checkId=f"{kind}:{node['name']}",
                    testName=node["name"],
                    category=kind,
                    kind=kind,
                    status="error",
                    failures=1,
                    node=uid,
                    columns=cols,
                    message=_short(text),
                )
            )
    return out


def summarize(results: list[CheckResult]) -> dict[str, int]:
    counts = {"pass": 0, "fail": 0, "error": 0, "skip": 0}
    for r in results:
        counts[r.status] = counts.get(r.status, 0) + 1
    return counts
