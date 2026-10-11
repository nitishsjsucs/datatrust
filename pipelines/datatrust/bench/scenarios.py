"""The 20 fault-injection scenarios (SPEC 12.1).

Source scenarios (S01-S13) mutate the generated dataset before it is written and loaded. Transformation
scenarios (T14-T20) apply a patch from `bench/patches/` to a temporary copy of the dbt project. Every trial
also applies 0 to 4 decoy patches from `bench/decoys/` (benign refactors that change model checksums
without changing output), drawn with `random.Random(seed * 1000 + scenario_index)`.

"Designed detectors" document intent only; the harness never uses them. Severity ranges are frozen here
before the test-seed run, and low severities are in range on purpose, so recall is measured, not
guaranteed. The ranker never sees anything in this module (ADR-0004).
"""

from __future__ import annotations

import datetime as dt
import random
from collections.abc import Callable
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path
from typing import Any

from datatrust.synth import rng as R
from datatrust.synth import spec as S
from datatrust.synth.generator import Dataset, Table

HERE = Path(__file__).parent
PATCHES = HERE / "patches"
DECOYS = HERE / "decoys"
PROJECT = "datatrust"

DEV_SEEDS = (1, 2, 3)
TEST_SEEDS = (101, 102, 103, 104, 105)


def model(name: str) -> str:
    return f"model.{PROJECT}.{name}"


def source(name: str) -> str:
    return f"source.{PROJECT}.raw.{name}"


Injector = Callable[[Dataset, random.Random, int], dict[str, Any]]


@dataclass(frozen=True)
class Scenario:
    id: str
    index: int
    kind: str  # source | transformation
    title: str
    ground_truth: str
    ground_truth_column: str | None
    detectors: tuple[str, ...]  # documentation only
    severity: tuple[int, int] | None = None
    inject: Injector | None = None
    patch: str | None = None
    # Models on the failing lineage path between the ground truth and its detectors (on-path decoys).
    path_models: tuple[str, ...] = field(default_factory=tuple)

    def patch_text(self) -> str | None:
        return (PATCHES / self.patch).read_text() if self.patch else None


# ------------------------------------------------------------------------------------ helpers


def rows(t: Table) -> list[dict[str, Any]]:
    names = [c for c, _ in t.columns]
    return [dict(zip(names, r, strict=True)) for r in t.rows]


def _set(t: Table, row: list[Any], col: str, value: Any) -> None:
    row[t.col(col)] = value


def _next_id(t: Table, col: str) -> int:
    i = t.col(col)
    return max(r[i] for r in t.rows) + 1


def _requisition_location(ds: Dataset) -> dict[int, int]:
    """application_id -> location_id of its requisition."""
    req_loc = {r["requisition_id"]: r["location_id"] for r in rows(ds["requisitions"])}
    return {a["application_id"]: req_loc[a["requisition_id"]] for a in rows(ds["applications"])}


# ------------------------------------------------------------------------------------ source scenarios


def inject_duplicate_hires(ds: Dataset, r: random.Random, k: int) -> dict[str, Any]:
    t = ds["hires"]
    picks = R.sample(r, range(len(t.rows)), k)
    new_id = _next_id(t, "hire_id")
    for n, i in enumerate(picks):
        dup = list(t.rows[i])
        _set(t, dup, "hire_id", new_id + n)
        t.rows.append(dup)
    return {"duplicated_hires": k}


def inject_orphan_applications(ds: Dataset, r: random.Random, k: int) -> dict[str, Any]:
    t = ds["applications"]
    picks = R.sample(r, range(len(t.rows)), k)
    for n, i in enumerate(picks):
        _set(t, t.rows[i], "requisition_id", 9_000 + n)
    return {"orphaned_applications": k}


def inject_stale_fx(ds: Dataset, r: random.Random, days: int) -> dict[str, Any]:
    currency = R.choice(r, [c for c in S.CURRENCIES if c != "USD"])
    t = ds["fx_rates"]
    series = [row for row in t.rows if row[t.col("currency")] == currency]
    series.sort(key=lambda row: row[t.col("rate_date")])
    start = R.randint(r, 0, len(series) - days - 1)
    frozen = series[start][t.col("rate_to_usd")]
    for row in series[start + 1 : start + 1 + days]:
        _set(t, row, "rate_to_usd", frozen)
    return {"currency": currency, "stale_days": days}


def inject_timezone_mismatch(ds: Dataset, r: random.Random, _: int) -> dict[str, Any]:
    """Recruiter events of one Asian location written as local wall-clock time labelled UTC."""
    from datatrust.synth.generator import zone

    loc_id = R.choice(r, [7, 8])  # Bengaluru or Singapore
    tz = next(loc.timezone for loc in S.LOCATIONS if loc.location_id == loc_id)
    app_loc = _requisition_location(ds)
    t = ds["stage_events"]
    changed = 0
    for row in t.rows:
        if row[t.col("source_system")] != "recruiter_tool":
            continue
        if app_loc[row[t.col("application_id")]] != loc_id:
            continue
        local = row[t.col("entered_at")].astimezone(zone(tz))
        _set(t, row, "entered_at", local.replace(tzinfo=dt.UTC))
        changed += 1
    return {"location_id": loc_id, "events": changed}


def inject_overlapping_assignments(ds: Dataset, r: random.Random, k: int) -> dict[str, Any]:
    t = ds["job_assignments"]
    by_emp: dict[int, list[list[Any]]] = {}
    for row in t.rows:
        by_emp.setdefault(row[t.col("employee_id")], []).append(row)
    multi = sorted(e for e, rs in by_emp.items() if len(rs) >= 2)
    for emp in R.sample(r, multi, k):
        ivs = sorted(by_emp[emp], key=lambda row: row[t.col("valid_from")])
        first = ivs[0]
        _set(t, first, "valid_to", first[t.col("valid_to")] + dt.timedelta(days=R.randint(r, 15, 60)))
    return {"employees": k}


def inject_missing_fx_days(ds: Dataset, r: random.Random, days: int) -> dict[str, Any]:
    currency = R.choice(r, [c for c in S.CURRENCIES if c != "USD"])
    t = ds["fx_rates"]
    idx = [i for i, row in enumerate(t.rows) if row[t.col("currency")] == currency]
    drop = set(R.sample(r, idx, days))
    t.rows = [row for i, row in enumerate(t.rows) if i not in drop]
    return {"currency": currency, "missing_days": days}


def inject_inverted_fx(ds: Dataset, r: random.Random, days: int) -> dict[str, Any]:
    t = ds["fx_rates"]
    series = sorted(
        (row for row in t.rows if row[t.col("currency")] == "INR"), key=lambda row: row[t.col("rate_date")]
    )
    start = R.randint(r, 0, len(series) - days)
    for row in series[start : start + days]:
        rate = row[t.col("rate_to_usd")]
        _set(t, row, "rate_to_usd", (Decimal(1) / rate).quantize(Decimal("0.000001")))
    return {"currency": "INR", "inverted_days": days}


def inject_out_of_order_stages(ds: Dataset, r: random.Random, k: int) -> dict[str, Any]:
    t = ds["stage_events"]
    by_app: dict[int, dict[str, list[Any]]] = {}
    for row in t.rows:
        by_app.setdefault(row[t.col("application_id")], {})[row[t.col("stage")]] = row
    eligible = sorted(a for a, st in by_app.items() if "Phone Screen" in st and "Onsite Interview" in st)
    for app in R.sample(r, eligible, k):
        screen, onsite = by_app[app]["Phone Screen"], by_app[app]["Onsite Interview"]
        ts = t.col("entered_at")
        screen[ts], onsite[ts] = onsite[ts], screen[ts]
    return {"applications": k}


def inject_payroll_double_posting(ds: Dataset, r: random.Random, _: int) -> dict[str, Any]:
    month = dt.date(2025, R.randint(r, 1, 12), 1)
    dept = R.randint(r, 1, len(S.DEPARTMENTS))
    a = ds["job_assignments"]
    in_dept = {
        row[a.col("employee_id")]
        for row in a.rows
        if row[a.col("department_id")] == dept
        and row[a.col("valid_from")] <= month
        and (row[a.col("valid_to")] is None or month < row[a.col("valid_to")])
    }
    t = ds["payroll_lines"]
    new_id = _next_id(t, "payroll_line_id")
    dups = []
    for row in t.rows:
        if row[t.col("pay_month")] == month and row[t.col("employee_id")] in in_dept:
            dup = list(row)
            _set(t, dup, "payroll_line_id", new_id + len(dups))
            dups.append(dup)
    t.rows.extend(dups)
    return {"month": month.isoformat(), "department_id": dept, "lines": len(dups)}


def inject_currency_mismatch(ds: Dataset, r: random.Random, k: int) -> dict[str, Any]:
    t = ds["compensation"]
    current = [row for row in t.rows if row[t.col("valid_to")] in (None, S.LEAVER_INTERVAL_END)]
    current.sort(key=lambda row: row[t.col("compensation_id")])
    for row in R.sample(r, current, k):
        cur = row[t.col("currency")]
        _set(t, row, "currency", R.choice(r, [c for c in S.CURRENCIES if c != cur]))
    return {"employees": k}


def inject_payroll_after_termination(ds: Dataset, r: random.Random, k: int) -> dict[str, Any]:
    e = ds["employees"]
    leavers = sorted(
        row[e.col("employee_id")] for row in e.rows if row[e.col("termination_date")] is not None
    )
    t = ds["payroll_lines"]
    last = {}
    for row in t.rows:
        emp = row[t.col("employee_id")]
        if emp in leavers and (emp not in last or row[t.col("pay_month")] > last[emp][t.col("pay_month")]):
            last[emp] = row
    new_id = _next_id(t, "payroll_line_id")
    for n, emp in enumerate(R.sample(r, leavers, k)):
        extra = list(last[emp])
        _set(t, extra, "payroll_line_id", new_id + n)
        _set(t, extra, "pay_month", dt.date(2025, 7, 1))
        _set(t, extra, "paid_at", extra[t.col("paid_at")] + dt.timedelta(days=30))
        t.rows.append(extra)
    return {"employees": k}


def inject_unknown_hire_employees(ds: Dataset, r: random.Random, k: int) -> dict[str, Any]:
    t = ds["hires"]
    for n, i in enumerate(R.sample(r, range(len(t.rows)), k)):
        _set(t, t.rows[i], "employee_id", 90_000 + n)
    return {"hires": k}


def inject_salary_as_text(ds: Dataset, r: random.Random, _: int) -> dict[str, Any]:
    t = ds["compensation"]
    i = t.col("base_salary_local_minor")
    t.columns[i] = ("base_salary_local_minor", "str")
    for row in t.rows:
        row[i] = f"{row[i]:,}"
    return {"column": "base_salary_local_minor", "delivered_as": "text with thousands separators"}


# ------------------------------------------------------------------------------------ the 20 scenarios

SCENARIOS: tuple[Scenario, ...] = (
    Scenario(
        "S01",
        1,
        "source",
        "duplicate hires (new hire_id, same application)",
        source("hires"),
        "application_id",
        ("U05", "X04"),
        (1, 20),
        inject_duplicate_hires,
        path_models=("stg_hires", "fct_hires"),
    ),
    Scenario(
        "S02",
        2,
        "source",
        "orphan applications (unknown requisition)",
        source("applications"),
        "requisition_id",
        ("R04",),
        (1, 30),
        inject_orphan_applications,
        path_models=("stg_applications",),
    ),
    Scenario(
        "S03",
        3,
        "source",
        "stale exchange rates (one currency frozen)",
        source("fx_rates"),
        "rate_to_usd",
        ("C03",),
        (3, 45),
        inject_stale_fx,
        path_models=("stg_fx_rates",),
    ),
    Scenario(
        "S04",
        4,
        "source",
        "timezone mismatch: recruiter events in local time labelled UTC",
        source("stage_events"),
        "entered_at",
        ("S05",),
        (1, 1),
        inject_timezone_mismatch,
        path_models=("stg_stage_events",),
    ),
    Scenario(
        "S05",
        5,
        "source",
        "overlapping assignment intervals",
        source("job_assignments"),
        "valid_to",
        ("H01",),
        (1, 25),
        inject_overlapping_assignments,
        path_models=("stg_job_assignments",),
    ),
    Scenario(
        "S06",
        6,
        "source",
        "missing FX days",
        source("fx_rates"),
        "rate_date",
        ("C04",),
        (1, 14),
        inject_missing_fx_days,
        path_models=("stg_fx_rates",),
    ),
    Scenario(
        "S07",
        7,
        "source",
        "inverted FX rate (units per USD stored as USD per unit)",
        source("fx_rates"),
        "rate_to_usd",
        ("C05",),
        (1, 10),
        inject_inverted_fx,
        path_models=("stg_fx_rates",),
    ),
    Scenario(
        "S08",
        8,
        "source",
        "out-of-order stage transitions",
        source("stage_events"),
        "stage",
        ("S02", "S03"),
        (1, 25),
        inject_out_of_order_stages,
        path_models=("stg_stage_events",),
    ),
    Scenario(
        "S09",
        9,
        "source",
        "payroll double posting for one department-month",
        source("payroll_lines"),
        None,
        ("X01",),
        (1, 1),
        inject_payroll_double_posting,
        path_models=("stg_payroll_lines", "fct_payroll_reconciliation"),
    ),
    Scenario(
        "S10",
        10,
        "source",
        "compensation currency mismatched to location",
        source("compensation"),
        "currency",
        ("C06",),
        (1, 20),
        inject_currency_mismatch,
        path_models=("stg_compensation", "int_compensation_usd", "fct_compensation_usd"),
    ),
    Scenario(
        "S11",
        11,
        "source",
        "payroll after termination",
        source("payroll_lines"),
        "pay_month",
        ("H07",),
        (1, 10),
        inject_payroll_after_termination,
        path_models=("stg_payroll_lines",),
    ),
    Scenario(
        "S12",
        12,
        "source",
        "hires linked to unknown employees",
        source("hires"),
        "employee_id",
        ("R05",),
        (1, 10),
        inject_unknown_hire_employees,
        path_models=("stg_hires",),
    ),
    Scenario(
        "S13",
        13,
        "source",
        "schema drift: salary delivered as text with separators",
        source("compensation"),
        "base_salary_local_minor",
        ("stg_compensation contract",),
        (1, 1),
        inject_salary_as_text,
        path_models=("stg_compensation",),
    ),
    Scenario(
        "T14",
        14,
        "transformation",
        "join fan-out: FX joined on currency only in int_compensation_usd",
        model("int_compensation_usd"),
        None,
        ("U02", "C02"),
        patch="T14_fx_join_on_currency_only.patch",
        path_models=("fct_compensation_usd",),
    ),
    Scenario(
        "T15",
        15,
        "transformation",
        "join fan-out: dim_employee joins all assignments, not current",
        model("dim_employee"),
        None,
        ("U06",),
        patch="T15_dim_employee_joins_all_assignments.patch",
    ),
    Scenario(
        "T16",
        16,
        "transformation",
        "timezone bug: stg_stage_events local date computed in UTC",
        model("stg_stage_events"),
        "event_local_date",
        ("S07",),
        patch="T16_local_date_computed_in_utc.patch",
    ),
    Scenario(
        "T17",
        17,
        "transformation",
        "interval predicate inclusive at both ends in the comp as-of join",
        model("int_employee_month"),
        None,
        ("U08",),
        patch="T17_comp_asof_join_inclusive_end.patch",
        path_models=("fct_payroll_reconciliation",),
    ),
    Scenario(
        "T18",
        18,
        "transformation",
        "annualization bug: expected gross divides by 26",
        model("fct_payroll_reconciliation"),
        "expected_gross_local_minor",
        ("X01",),
        patch="T18_expected_gross_divides_by_26.patch",
    ),
    Scenario(
        "T19",
        19,
        "transformation",
        "stage code mapping swaps screen and onsite",
        model("stg_stage_events"),
        "stage",
        ("S02",),
        patch="T19_stage_mapping_swaps_screen_and_onsite.patch",
    ),
    Scenario(
        "T20",
        20,
        "transformation",
        "headcount metric drops the termination filter",
        model("metric_headcount_monthly"),
        None,
        ("X02",),
        patch="T20_metric_drops_termination_filter.patch",
    ),
)

BY_ID: dict[str, Scenario] = {s.id: s for s in SCENARIOS}

# Named resume scenarios: duplicate hires, join fan-out, stale exchange rates, timezone mismatches.
NAMED = {
    "duplicate hires": ("S01",),
    "join fan-out": ("T14", "T15"),
    "stale exchange rates": ("S03",),
    "timezone mismatches": ("S04", "T16"),
}


@dataclass(frozen=True)
class Decoy:
    id: str
    file: str
    model: str

    def text(self) -> str:
        return (DECOYS / self.file).read_text()


def decoys() -> tuple[Decoy, ...]:
    out = []
    for path in sorted(DECOYS.glob("D*.patch")):
        header = next(ln for ln in path.read_text().splitlines() if ln.startswith("+++ "))
        model_name = Path(header[4:].strip()).stem
        out.append(Decoy(path.stem.split("_", 1)[0], path.name, model_name))
    return tuple(out)


def draw_decoys(seed: int, scenario_index: int) -> list[Decoy]:
    """0 to 4 decoys; with probability 0.5 at least one from a model on the scenario's failing path.

    Seeded with `random.Random(seed * 1000 + scenario_index)` (never Python hash(), which is salted).
    Scenario index 0 is the clean trial.
    """
    r = random.Random(seed * 1000 + scenario_index)
    pool = list(decoys())
    n = R.randint(r, 0, 4)
    on_path_wanted = R.chance(r, 1, 2)
    path_models: tuple[str, ...] = ()
    if scenario_index > 0:
        path_models = SCENARIOS[scenario_index - 1].path_models
    chosen: list[Decoy] = []
    on_path = [d for d in pool if d.model in path_models]
    if on_path_wanted and n > 0 and on_path:
        first = R.choice(r, on_path)
        chosen.append(first)
        pool.remove(first)
    while len(chosen) < n:
        pick = R.choice(r, pool)
        chosen.append(pick)
        pool.remove(pick)
    return sorted(chosen, key=lambda d: d.id)


def draw_severity(seed: int, scenario: Scenario) -> tuple[int, random.Random]:
    """Severity and the injection's own random stream, independent of the decoy draw."""
    r = random.Random(seed * 1000 + 500 + scenario.index)
    lo, hi = scenario.severity or (1, 1)
    return R.randint(r, lo, hi), r


def patches_for(seed: int, scenario: Scenario | None) -> tuple[list[str], list[str]]:
    """(patch texts, decoy ids) for one trial; the scenario patch first, then the decoys."""
    idx = scenario.index if scenario else 0
    chosen = draw_decoys(seed, idx)
    texts = []
    if scenario and scenario.patch_text():
        texts.append(scenario.patch_text() or "")
    texts.extend(d.text() for d in chosen)
    return texts, [d.id for d in chosen]


def inject(ds: Dataset, seed: int, scenario: Scenario) -> dict[str, Any]:
    if scenario.inject is None:
        return {}
    severity, r = draw_severity(seed, scenario)
    info = scenario.inject(ds, r, severity)
    return {"severity": severity, **info}
