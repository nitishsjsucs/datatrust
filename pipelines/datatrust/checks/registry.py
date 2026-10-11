"""Load `checks/registry.yml`: the 40 checks with category, tested node and columns (SPEC 8)."""

from __future__ import annotations

from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

import yaml

from datatrust import config

REGISTRY_PATH = config.REPO_ROOT / "checks" / "registry.yml"
PROJECT = "datatrust"

CATEGORY_COUNTS = {
    "uniqueness": 8,
    "referential": 8,
    "interval": 7,
    "stage_transition": 7,
    "compensation": 6,
    "reconciliation": 4,
}


def model_id(name: str) -> str:
    return f"model.{PROJECT}.{name}"


@dataclass(frozen=True)
class Target:
    node: str  # dbt unique_id
    columns: tuple[str, ...]


@dataclass(frozen=True)
class Check:
    id: str
    test: str
    category: str
    kind: str  # generic | singular
    node: str  # dbt unique_id of the tested node
    columns: tuple[str, ...]
    severity: str
    also: tuple[Target, ...] = field(default_factory=tuple)

    def targets(self) -> tuple[Target, ...]:
        return (Target(self.node, self.columns), *self.also)


@dataclass(frozen=True)
class Registry:
    checks: tuple[Check, ...]

    def by_test(self) -> dict[str, Check]:
        return {c.test: c for c in self.checks}

    def by_id(self) -> dict[str, Check]:
        return {c.id: c for c in self.checks}


def parse(doc: dict) -> Registry:
    checks = []
    for raw in doc["checks"]:
        checks.append(
            Check(
                id=raw["id"],
                test=raw["test"],
                category=raw["category"],
                kind=raw["kind"],
                node=model_id(raw["node"]),
                columns=tuple(raw["columns"]),
                severity=raw.get("severity", "error"),
                also=tuple(Target(model_id(a["node"]), tuple(a["columns"])) for a in raw.get("also", [])),
            )
        )
    return Registry(tuple(checks))


@lru_cache(maxsize=1)
def load(path: Path = REGISTRY_PATH) -> Registry:
    return parse(yaml.safe_load(path.read_text()))
