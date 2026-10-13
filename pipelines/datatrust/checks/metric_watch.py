"""Metric watch: a failed metric is a closed period whose value moved since the last green run (SPEC 13.1).

Every model whose meta names a `metric` column and a `grain` is a metric (the four `metric_*` models). The
calendar is closed (SPEC 6.2, 2025), so a metric's history must not change between runs: a cell (one grain
value) whose metric differs from the last green run's Parquet snapshot, or that appeared or disappeared, is a
changed cell, and a metric with a changed cell has failed. Duplicated grain rows are summed, so a fan-out
shows as a changed value too. The comparison runs on the read-only DuckDB connection with the same SQL guard
as the probes; it reads the snapshot only under the snapshot root.

The runner reports one alert per run, for the metric with the largest share of changed cells (ties by node
id), and only when every check passed: a failing check already starts an investigation for the run, and one
alert keeps a run at one investigation on the Free plan (SPEC 28). The alert's `observed` and `expected` are
the values of the cell that moved most (0 for a missing cell); they are counts or sums, never a person's row.
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from datatrust.warehouse.duckdb_wh import DuckDBWarehouse

_IDENT = re.compile(r"^[a-z_][a-z0-9_]*$")
META_FILE = "_meta.json"
# Decimal metrics are exact on DuckDB; the tolerance only absorbs float rounding if a metric is ever a double.
RELATIVE_TOLERANCE = 1e-9


@dataclass(frozen=True)
class MetricSpec:
    node: str
    name: str
    schema: str
    identifier: str
    grain: tuple[str, ...]
    column: str


@dataclass(frozen=True)
class MetricChange:
    node: str
    column: str
    cells: int
    changed: int
    observed: float
    expected: float

    @property
    def share(self) -> float:
        return self.changed / self.cells if self.cells else 0.0

    def to_json(self) -> dict[str, Any]:
        return asdict(self)


def metric_specs(relations: dict[str, Any]) -> list[MetricSpec]:
    """Models with `meta.metric` and `meta.grain`, materialized as tables, in node id order."""
    out = []
    for uid, n in sorted(relations["nodes"].items()):
        meta = n.get("meta") or {}
        if n["kind"] != "model" or n.get("materialization") != "table" or not meta.get("metric"):
            continue
        grain = tuple(meta.get("grain") or ())
        idents = [meta["metric"], *grain, n["schema"], n["identifier"], n["name"]]
        if not grain or not all(_IDENT.match(str(x)) for x in idents):
            continue
        out.append(MetricSpec(uid, n["name"], n["schema"], n["identifier"], grain, meta["metric"]))
    return out


def _compare_sql(spec: MetricSpec, parquet: Path) -> str:
    g = ", ".join(spec.grain)
    on = " and ".join(f"cur.{c} is not distinct from base.{c}" for c in spec.grain)
    path = str(parquet).replace("'", "''")
    return f"""
with cur as (
  select {g}, sum({spec.column}) as v, count(*) as n from "{spec.schema}"."{spec.identifier}" group by {g}
),
base as (
  select {g}, sum({spec.column}) as v, count(*) as n from read_parquet('{path}') group by {g}
),
j as (
  select {", ".join(f"coalesce(cur.{c}, base.{c}) as {c}" for c in spec.grain)},
         cur.v as cv, base.v as bv, cur.n as cn, base.n as bn
  from cur full outer join base on {on}
)
select
  cast(coalesce(cv, 0) as double) as observed,
  cast(coalesce(bv, 0) as double) as expected,
  abs(cast(coalesce(cv, 0) as double) - cast(coalesce(bv, 0) as double)) as delta,
  (cn is distinct from bn)
    or (cv is distinct from bv
        and (cv is null or bv is null
             or abs(cv - bv) > {RELATIVE_TOLERANCE} * greatest(1, abs(bv)))) as moved
from j
order by moved desc, delta desc, {g}
"""


def compare_metrics(db: Path, relations: dict[str, Any], baseline_dir: Path) -> list[MetricChange]:
    """Every metric that has a snapshot in `baseline_dir` (`<model name>.parquet`), compared cell by cell."""
    out: list[MetricChange] = []
    baseline_dir = Path(baseline_dir).resolve()
    with DuckDBWarehouse(db, snapshot_dir=baseline_dir) as wh:
        for spec in metric_specs(relations):
            parquet = baseline_dir / f"{spec.name}.parquet"
            if not parquet.exists() or not wh.relation_columns(relations["nodes"][spec.node]):
                continue
            rows = wh.query(_compare_sql(spec, parquet), max_rows=1_000_000)
            changed = sum(1 for r in rows if r["moved"])
            top = rows[0] if rows and rows[0]["moved"] else None
            out.append(
                MetricChange(
                    node=spec.node,
                    column=spec.column,
                    cells=len(rows),
                    changed=changed,
                    observed=float(top["observed"]) if top else 0.0,
                    expected=float(top["expected"]) if top else 0.0,
                )
            )
    return out


def failed_metrics(changes: list[MetricChange]) -> list[MetricChange]:
    return [c for c in changes if c.changed > 0]


def choose_alert(changes: list[MetricChange]) -> dict[str, Any] | None:
    """The alert body (without runId) for the failed metric with the largest share of changed cells."""
    failed = sorted(failed_metrics(changes), key=lambda c: (-c.share, c.node))
    if not failed:
        return None
    c = failed[0]
    return {"metricNode": c.node, "column": c.column, "observed": c.observed, "expected": c.expected}


def write_snapshot_meta(snapshot: Path, *, seed: int, target: str) -> None:
    (snapshot / META_FILE).write_text(
        json.dumps({"seed": seed, "target": target, "finishedAt": time.time()}, sort_keys=True) + "\n"
    )


def last_green_snapshot(snapshot_root: Path, *, seed: int, target: str = "duckdb") -> Path | None:
    """The newest snapshot a green run of the same seed and target left (older snapshots without metadata
    are ignored: the watch only compares like with like)."""
    best: tuple[float, str, Path] | None = None
    if not snapshot_root.exists():
        return None
    for d in snapshot_root.iterdir():
        meta_path = d / META_FILE
        if not meta_path.is_file():
            continue
        try:
            meta = json.loads(meta_path.read_text())
        except (OSError, ValueError):
            continue
        if meta.get("seed") != seed or meta.get("target") != target:
            continue
        key = (float(meta.get("finishedAt") or 0.0), d.name, d)
        if best is None or key[:2] > best[:2]:
            best = key
    return best[2] if best else None
