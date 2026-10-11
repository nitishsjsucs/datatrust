"""Diagnostic probes: registry, rendering per dialect, execution and anomaly scores (SPEC 10).

The Worker sends probe invocations (probe kind, node id, columns, params), never SQL. The runner renders
SQL from its own templates with identifiers resolved through its own relations.json and validated against
the warehouse's information schema, checks the text with the read-only guard, executes it on a read-only
identity and returns aggregates plus at most 5 sample keys (tokenized later by `rca sanitize`).
"""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import asdict, dataclass, field
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

import jinja2

from datatrust.synth import spec as S

TEMPLATES = Path(__file__).parent / "templates"
_ENV = jinja2.Environment(
    loader=jinja2.FileSystemLoader(str(TEMPLATES)),
    undefined=jinja2.StrictUndefined,
    autoescape=False,
    trim_blocks=False,
    lstrip_blocks=False,
)
IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
SECTION = re.compile(r"^-- @(\w+)\s*$", re.M)
CALENDAR = {"calendar_start": S.CALENDAR_START.isoformat(), "calendar_end": S.CALENDAR_END.isoformat()}


class ProbeError(ValueError):
    """The request cannot be rendered (unknown node, column or parameter)."""


@dataclass(frozen=True)
class ProbeRequest:
    probe_id: str
    probe: str
    node: str
    columns: tuple[str, ...]
    params: Mapping[str, Any] = field(default_factory=dict)

    @staticmethod
    def from_json(d: Mapping[str, Any]) -> ProbeRequest:
        return ProbeRequest(
            probe_id=str(d["probeId"]),
            probe=str(d["probe"]),
            node=str(d["node"]),
            columns=tuple(d.get("columns") or ()),
            params=dict(d.get("params") or {}),
        )


@dataclass
class ProbeResult:
    probe_id: str
    probe: str
    node: str
    columns: tuple[str, ...]
    metric: str
    value: float
    anomaly: float
    sql: list[str]
    dialect: str
    status: str = "ok"  # ok | error | missing
    sample_keys: list[dict[str, Any]] = field(default_factory=list)
    details: dict[str, Any] = field(default_factory=dict)
    error: str | None = None

    def to_json(self) -> dict[str, Any]:
        d = asdict(self)
        return {
            "probeId": d["probe_id"],
            "probe": d["probe"],
            "node": d["node"],
            "columns": list(d["columns"]),
            "metric": d["metric"],
            "value": d["value"],
            "anomaly": d["anomaly"],
            "sql": d["sql"],
            "dialect": d["dialect"],
            "status": d["status"],
            "sampleKeys": d["sample_keys"],
            "details": d["details"],
            "error": d["error"],
        }


def _clip(x: float) -> float:
    return max(0.0, min(1.0, float(x)))


def _ratio(n: Any, d: Any) -> float:
    n, d = float(n or 0), float(d or 0)
    return 0.0 if d == 0 else n / d


@dataclass(frozen=True)
class ProbeSpec:
    metric: str
    measure: Callable[[dict[str, Any], Mapping[str, Any]], tuple[float, float, dict[str, Any]]]
    needs_columns: int = 0  # minimum number of columns


def _m_dup(row, p):
    v = _ratio(row["n_dup"], row["n_rows"])
    return v, _clip(v / 0.001), {"n_rows": int(row["n_rows"] or 0), "n_dup": int(row["n_dup"] or 0)}


def _m_null(row, p):
    v = _ratio(row["n_null"], row["n_rows"])
    return v, _clip(v / 0.01), {"n_rows": int(row["n_rows"] or 0)}


def _m_orphan(row, p):
    v = _ratio(row["n_orphan"], row["n_rows"])
    return v, _clip(v / 0.001), {"n_rows": int(row["n_rows"] or 0), "n_orphan": int(row["n_orphan"] or 0)}


def _m_fanout(row, p):
    v = _ratio(row["n_rows"], row["n_groups"]) if row["n_groups"] else 1.0
    details = {"n_rows": int(row["n_rows"] or 0), "n_groups": int(row["n_groups"] or 0)}
    return v, _clip((v - 1.0) / 0.01), details


def _m_rowcount(row, p):
    v = _ratio(row["n_rows"], row["n_parent"])
    expected = float(p.get("ratio") or 1.0)
    return v, _clip(abs(v / expected - 1.0) / 0.01), {"expected_ratio": expected}


def _m_stale(row, p):
    run = int(row["run_days"] or 1) if row else 1
    details = {"currency": row["currency"]} if row else {}
    return float(run), _clip((run - 1) / 3), details


def _m_gaps(row, p):
    gaps = int(row["max_missing"] or 0)
    return float(gaps), _clip(gaps / 1), {"total_missing": int(row["total_missing"] or 0)}


def _m_band(row, p):
    v = _ratio(row["n_outside"], row["n_rows"])
    return v, _clip(v / 0.001), {"n_rows": int(row["n_rows"] or 0), "n_outside": int(row["n_outside"] or 0)}


def _m_tz(row, p):
    if not row:
        return 0.0, 0.0, {}
    v = _ratio(row["n_outside"], row["n_events"])
    return v, _clip(v / 0.02), {"tz": row["tz"], "n_events": int(row["n_events"] or 0)}


def _m_overlap(row, p):
    v = _ratio(row["n_pairs"], row["n_keys"])
    return v, _clip(v / 0.001), {"n_pairs": int(row["n_pairs"] or 0), "n_keys": int(row["n_keys"] or 0)}


def _m_transition(row, p):
    v = _ratio(row["n_bad"], row["n_keys"])
    return v, _clip(v / 0.001), {"n_keys": int(row["n_keys"] or 0), "n_bad": int(row["n_bad"] or 0)}


def _m_recompute(row, p):
    if p.get("compare") == "exact":
        v = _ratio(row["n_bad"], row["n_rows"])
        return v, _clip(v / 0.001), {"n_rows": int(row["n_rows"] or 0), "compare": "exact"}
    v = float(row["mean_rel_error"] or 0.0)
    return v, _clip(v / 0.005), {"n_rows": int(row["n_rows"] or 0), "compare": "numeric"}


def _m_cast(row, p):
    v = _ratio(row["n_fail"], row["n_rows"])
    return v, _clip(v / 0.001), {"n_rows": int(row["n_rows"] or 0), "type": p.get("type")}


def _m_delta(row, p):
    then = row.get("n_rows_then")
    now = row.get("n_rows_now")
    return _ratio(now, then) if then else 0.0, 0.0, {"n_rows_now": now, "n_rows_then": then}


PROBES: dict[str, ProbeSpec] = {
    "dup_key_rate": ProbeSpec("duplicate_row_rate", _m_dup, 1),
    "null_rate": ProbeSpec("null_share", _m_null, 1),
    "orphan_rate": ProbeSpec("orphan_share", _m_orphan, 1),
    "fanout_ratio": ProbeSpec("rows_per_grain", _m_fanout, 1),
    "rowcount_ratio": ProbeSpec("rowcount_vs_parent", _m_rowcount, 0),
    "fx_stale_run": ProbeSpec("longest_identical_rate_run_days", _m_stale, 0),
    "date_gaps": ProbeSpec("max_missing_days_per_key", _m_gaps, 0),
    "fx_band_violation": ProbeSpec("share_outside_15pct_of_trailing_median", _m_band, 0),
    "tz_hour_profile": ProbeSpec("share_outside_local_business_hours", _m_tz, 0),
    "interval_overlap": ProbeSpec("overlapping_pairs_per_key", _m_overlap, 0),
    "transition_violation": ProbeSpec("share_with_backward_transition", _m_transition, 0),
    "recompute_delta": ProbeSpec("recompute_error", _m_recompute, 1),
    "cast_failure": ProbeSpec("cast_failure_share", _m_cast, 1),
    "delta_vs_last_green": ProbeSpec("rowcount_vs_last_green", _m_delta, 0),
}

# ------------------------------------------------------------------------------------ rendering


def relation_sql(node: Mapping[str, Any], dialect: str) -> str:
    schema, ident = node["schema"], node["identifier"]
    for part in (schema, ident):
        if not IDENT.match(part):
            raise ProbeError(f"unsafe relation part {part!r}")
    if dialect == "bigquery":
        db = node.get("database") or ""
        if not re.match(r"^[a-z][a-z0-9-]{4,62}$", db):
            raise ProbeError(f"unsafe project id {db!r}")
        return f"`{db}.{schema}.{ident}`"
    return f'"{schema}"."{ident}"'


_EXPR_TOKEN = re.compile(r"\s*(?:(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|([-+*/(),]))")
_EXPR_FUNCS = {"tz_local_date", "int_div"}


def render_expression(expr: str, columns: set[str], dialect: str) -> str:
    """Probe expression language: columns, numbers, + - * / ( ) and tz_local_date(), int_div()."""
    pos, tokens = 0, []
    while pos < len(expr):
        m = _EXPR_TOKEN.match(expr, pos)
        if not m or m.end() == pos:
            raise ProbeError(f"bad expression near {expr[pos:]!r}")
        num, name, op = m.groups()
        if name is not None and name not in _EXPR_FUNCS and name not in columns:
            raise ProbeError(f"unknown identifier {name!r} in expression")
        tokens.append(num or name or op)
        pos = m.end()
    text = " ".join(tokens).replace("( ", "(").replace(" )", ")").replace(" ,", ",")

    def rewrite(match: re.Match[str]) -> str:
        fn, a, b = match.group(1), match.group(2).strip(), match.group(3).strip()
        if fn == "tz_local_date":
            return f"DATE({a}, {b})" if dialect == "bigquery" else f"cast(timezone({b}, {a}) as date)"
        return f"DIV({a}, {b})" if dialect == "bigquery" else f"(({a}) // ({b}))"

    pattern = re.compile(r"\b(tz_local_date|int_div)\s*\(([^(),]+(?:\([^()]*\))?[^(),]*),([^()]+)\)")
    while pattern.search(text):
        text = pattern.sub(rewrite, text)
    return text


ColumnLookup = Callable[[Mapping[str, Any]], set[str]]


def _node(relations: Mapping[str, Any], node_id: str) -> Mapping[str, Any]:
    node = relations["nodes"].get(node_id)
    if node is None:
        raise ProbeError(f"unknown node {node_id}")
    return node


def _check_cols(cols: Sequence[str], available: set[str], where: str) -> None:
    for c in cols:
        if not isinstance(c, str) or not IDENT.match(c):
            raise ProbeError(f"unsafe column {c!r}")
        if c not in available:
            raise ProbeError(f"column {c} not in {where}")


def render(
    req: ProbeRequest, relations: Mapping[str, Any], dialect: str, columns_of: ColumnLookup
) -> dict[str, str]:
    """Render a probe to its SQL sections ({'main': ..., 'samples'?: ..., 'historical'?: ...})."""
    if req.probe not in PROBES:
        raise ProbeError(f"unknown probe {req.probe}")
    node = _node(relations, req.node)
    available = columns_of(node)
    if not available:
        raise ProbeError(f"relation for {req.node} does not exist")
    cols = list(req.columns)
    _check_cols(cols, available, req.node)
    if len(cols) < PROBES[req.probe].needs_columns:
        raise ProbeError(f"{req.probe} needs columns")
    p: dict[str, Any] = dict(CALENDAR)
    raw = dict(req.params)
    ctx: dict[str, Any] = {"rel": relation_sql(node, dialect), "cols": cols, "dialect": dialect, "p": p}

    def ident_param(key: str, required: bool = True) -> str | None:
        v = raw.get(key)
        if v is None:
            if required:
                raise ProbeError(f"{req.probe} needs param {key}")
            return None
        _check_cols([v], available, req.node)
        p[key] = v
        return v

    def parent_rel(parent_id: str, parent_cols: Sequence[str]) -> str:
        parent = _node(relations, parent_id)
        pav = columns_of(parent)
        if not pav:
            raise ProbeError(f"relation for {parent_id} does not exist")
        _check_cols(parent_cols, pav, parent_id)
        return relation_sql(parent, dialect)

    kind = req.probe
    if kind == "orphan_rate":
        pc = raw.get("parent_column")
        ctx["parent_rel"] = parent_rel(str(raw.get("parent")), [pc])
        p["parent_column"] = pc
    elif kind == "rowcount_ratio":
        ctx["parent_rel"] = parent_rel(str(raw.get("parent")), [])
        p["ratio"] = float(raw.get("ratio") or 1.0)
    elif kind in ("fx_stale_run", "date_gaps", "fx_band_violation"):
        for k in ("currency", "date", "rate") if kind != "date_gaps" else ("currency", "date"):
            ident_param(k)
    elif kind == "tz_hour_profile":
        ident_param("ts")
        ident_param("filter_column", required=False)
        fv = raw.get("filter_value")
        if fv is not None:
            if not IDENT.match(str(fv)):
                raise ProbeError("unsafe filter value")
            p["filter_value"] = fv
        path = raw.get("tz_path") or []
        if path:
            hops, prev_cols = [], available
            for hop in path:
                _check_cols([hop["column"]], prev_cols, "tz path")
                parent = _node(relations, hop["parent"])
                pav = columns_of(parent)
                _check_cols([hop["parent_column"]], pav, hop["parent"])
                hops.append(
                    {
                        "column": hop["column"],
                        "parent_column": hop["parent_column"],
                        "parent_rel": relation_sql(parent, dialect),
                    }
                )
                prev_cols = pav
                if hop.get("tz"):
                    _check_cols([hop["tz"]], pav, hop["parent"])
                    p["tz_column"] = hop["tz"]
            p["tz_path"] = hops
        else:
            ident_param("tz")
            p["tz_path"] = []
    elif kind == "interval_overlap":
        key = raw.get("key") or []
        _check_cols(key, available, req.node)
        p["key"] = list(key)
        for k in ("from", "to", "id"):
            ident_param(k)
    elif kind == "transition_violation":
        ident_param("key")
        ident_param("ts")
        if raw.get("order"):
            ident_param("order")
            p["order_map"] = {}
        else:
            ident_param("stage")
            om = raw.get("order_map") or {}
            for label, order in om.items():
                if not re.match(r"^[A-Za-z][A-Za-z ]*$", str(label)) or not isinstance(order, int):
                    raise ProbeError("unsafe order map")
            p["order"] = None
            p["order_map"] = dict(om)
    elif kind == "recompute_delta":
        p["compare"] = "exact" if raw.get("compare") == "exact" else "numeric"
        ctx["expr"] = render_expression(str(raw.get("expr", "")), available, dialect)
    elif kind == "cast_failure":
        t = raw.get("type", "int")
        if t not in ("int", "money", "date", "ts"):
            raise ProbeError("unsupported cast type")
        p["type"] = t
    elif kind == "delta_vs_last_green":
        if dialect == "bigquery":
            p["as_of_ms"] = int(raw["as_of_ms"])
        else:
            path = str(raw.get("snapshot_path", ""))
            if not re.match(r"^[A-Za-z0-9_./-]+\.parquet$", path) or ".." in path:
                raise ProbeError("unsafe snapshot path")
            p["snapshot_path"] = path
    template = _ENV.get_template(f"{kind}.sql.j2")
    macros = _ENV.get_template("_macros.sql.j2").make_module({"dialect": dialect})
    text = template.render(**ctx, m=macros)
    return split_sections(text)


def split_sections(text: str) -> dict[str, str]:
    parts = SECTION.split(text)
    out = {"main": parts[0].strip()}
    for i in range(1, len(parts), 2):
        out[parts[i]] = parts[i + 1].strip()
    return out


# ------------------------------------------------------------------------------------ execution


def _jsonable(v: Any) -> Any:
    if isinstance(v, Decimal):
        return float(v)
    if isinstance(v, datetime | date):
        return v.isoformat()
    return v


def run_probe(req: ProbeRequest, wh: Any, relations: Mapping[str, Any]) -> ProbeResult:
    spec = PROBES.get(req.probe)
    metric = spec.metric if spec else "unknown"
    base = {
        "probe_id": req.probe_id,
        "probe": req.probe,
        "node": req.node,
        "columns": req.columns,
        "metric": metric,
        "dialect": wh.dialect,
    }
    try:
        sections = render(req, relations, wh.dialect, wh.relation_columns)
    except ProbeError as err:
        status = "missing" if "does not exist" in str(err) else "error"
        return ProbeResult(**base, value=0.0, anomaly=0.0, sql=[], status=status, error=type(err).__name__)
    try:
        rows = wh.query(sections["main"], max_rows=1)
        row = {k: _jsonable(v) for k, v in rows[0].items()} if rows else {}
        if "historical" in sections:
            hist = wh.query(sections["historical"], max_rows=1)
            row.update({k: _jsonable(v) for k, v in (hist[0] if hist else {}).items()})
        assert spec is not None
        value, anomaly, details = spec.measure(row, {**dict(req.params)})
        samples: list[dict[str, Any]] = []
        if "samples" in sections and anomaly > 0:
            for s in wh.query(sections["samples"], max_rows=5):
                samples.append({k: _jsonable(v) for k, v in s.items() if k != "c"})
        sql = [sections[k] for k in ("main", "historical") if k in sections]
        return ProbeResult(
            **base,
            value=float(value),
            anomaly=float(anomaly),
            sql=sql,
            status="ok",
            sample_keys=samples,
            details={k: _jsonable(v) for k, v in details.items()},
        )
    except Exception as err:  # noqa: BLE001 - a failing probe must not stop the investigation
        return ProbeResult(
            **base,
            value=0.0,
            anomaly=0.0,
            sql=[sections["main"]],
            status="error",
            error=type(err).__name__,
        )


def run_probes(requests: Sequence[ProbeRequest], wh: Any, relations: Mapping[str, Any]) -> list[ProbeResult]:
    return [run_probe(r, wh, relations) for r in requests]
