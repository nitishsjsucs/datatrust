"""Seeded synthetic workforce generator (SPEC section 6).

Determinism rules (SPEC 6.1):
- randomness only through ``rng`` helpers built on ``random.Random.random()``;
- integer arithmetic for money (minor units) and FX (micro-units);
- every instant is a tz-aware UTC ``datetime``;
- time zones come from the pinned ``tzdata`` package only (``zoneinfo.reset_tzpath([])``).
"""

from __future__ import annotations

import csv
import datetime as dt
import hashlib
import io
import json
import zoneinfo
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path
from typing import Any

from datatrust.synth import rng as R
from datatrust.synth import spec as S
from datatrust.synth.wordlists import FIRST_NAMES, LAST_NAMES

UTC = dt.UTC


@dataclass
class Table:
    name: str
    columns: list[tuple[str, str]]
    rows: list[list[Any]] = field(default_factory=list)

    def col(self, name: str) -> int:
        for i, (c, _) in enumerate(self.columns):
            if c == name:
                return i
        raise KeyError(f"{self.name}.{name}")

    def kind(self, name: str) -> str:
        return self.columns[self.col(name)][1]


@dataclass
class Dataset:
    seed: int
    tables: dict[str, Table]

    def __getitem__(self, name: str) -> Table:
        return self.tables[name]

    def counts(self) -> dict[str, int]:
        return {name: len(t.rows) for name, t in self.tables.items()}


# --------------------------------------------------------------------------- time zones

_ZONES: dict[str, zoneinfo.ZoneInfo] = {}


def _pin_tzdata() -> None:
    """Use only the pinned tzdata package, never the OS zone files (SPEC 6.1, review M1)."""
    import tzdata

    if tzdata.IANA_VERSION != S.TZDATA_VERSION:
        raise RuntimeError(f"tzdata IANA {tzdata.IANA_VERSION} != pinned {S.TZDATA_VERSION}")
    if zoneinfo.TZPATH:
        zoneinfo.reset_tzpath([])
        zoneinfo.ZoneInfo.clear_cache()
        _ZONES.clear()


def zone(name: str) -> zoneinfo.ZoneInfo:
    z = _ZONES.get(name)
    if z is None:
        z = zoneinfo.ZoneInfo(name)
        _ZONES[name] = z
    return z


def local_instant(day: dt.date, seconds_of_day: int, tz: str) -> dt.datetime:
    """UTC instant of a local wall-clock time on ``day`` in zone ``tz``."""
    hh, rem = divmod(seconds_of_day, 3600)
    mm, ss = divmod(rem, 60)
    local = dt.datetime(day.year, day.month, day.day, hh, mm, ss, tzinfo=zone(tz))
    return local.astimezone(UTC)


def utc_instant(day: dt.date, seconds_of_day: int) -> dt.datetime:
    return dt.datetime(day.year, day.month, day.day, tzinfo=UTC) + dt.timedelta(seconds=seconds_of_day)


# --------------------------------------------------------------------------- calendar helpers


def month_index_to_date(index: int) -> dt.date:
    """Month index 0 = 2015-01; returns the 1st of that month."""
    year, month0 = divmod(index, 12)
    return dt.date(2015 + year, month0 + 1, 1)


def month_index(day: dt.date) -> int:
    return (day.year - 2015) * 12 + (day.month - 1)


INDEX_2025_01 = month_index(dt.date(2025, 1, 1))  # 120
INDEX_2025_06 = month_index(dt.date(2025, 6, 1))  # 125
INDEX_2025_12 = month_index(dt.date(2025, 12, 1))  # 131


def fx_micros_to_decimal(micros: int) -> Decimal:
    sign = "-" if micros < 0 else ""
    m = abs(micros)
    return Decimal(f"{sign}{m // 1_000_000}.{m % 1_000_000:06d}")


# --------------------------------------------------------------------------- generator


def _seed(seed: int, stream: int) -> int:
    """Independent sub-stream per component so one table's draws never shift another's."""
    return seed * 100 + stream


def _new_tables() -> dict[str, Table]:
    return {name: Table(name, list(S.TABLE_COLUMNS[name])) for name in S.TABLE_ORDER}


def generate(seed: int) -> Dataset:
    _pin_tzdata()
    t = _new_tables()
    loc_by_id = {loc.location_id: loc for loc in S.LOCATIONS}

    # ---- reference tables
    for dept_id, name, cc in S.DEPARTMENTS:
        t["departments"].rows.append([dept_id, name, cc])
    for loc in S.LOCATIONS:
        t["locations"].rows.append([loc.location_id, loc.name, loc.country_code, loc.timezone, loc.currency])

    # ---- requisitions and application paths
    r = R.make(_seed(seed, 1))
    reqs: list[dict[str, Any]] = []
    apps: list[dict[str, Any]] = []
    for req_id in range(1, S.REQUISITIONS + 1):
        two_hires = req_id <= S.TWO_HIRE_REQUISITIONS
        dept_id = R.randint(r, 1, len(S.DEPARTMENTS))
        loc_id = R.randint(r, 1, len(S.LOCATIONS))
        title = R.choice(r, S.JOB_TITLES[dept_id])
        mix = S.PATH_MIX_TWO_HIRES if two_hires else S.PATH_MIX_ONE_HIRE
        paths = [p for p, n in mix.items() for _ in range(n)]
        R.shuffle(r, paths)
        reqs.append(
            {"id": req_id, "dept": dept_id, "loc": loc_id, "title": title, "openings": 2 if two_hires else 1}
        )
        for k, path in enumerate(paths):
            apps.append(
                {"id": (req_id - 1) * S.APPLICATIONS_PER_REQUISITION + k + 1, "req": req_id, "path": path}
            )

    # ---- hires: 30 per month of 2025, employee ids ordered by hire date
    hired_apps = [a for a in apps if a["path"] == "P5"]
    R.shuffle(r, hired_apps)
    for idx, a in enumerate(hired_apps):
        a["hire_date"] = dt.date(2025, idx // S.HIRES_PER_MONTH + 1, 1)
    hired_apps.sort(key=lambda a: (a["hire_date"], a["id"]))
    first_c_id = S.COHORT_A + S.COHORT_B + 1
    for idx, a in enumerate(hired_apps):
        a["employee_id"] = first_c_id + idx

    # ---- requisition open dates anchor every timeline
    earliest_hire: dict[int, dt.date] = {}
    for a in hired_apps:
        cur = earliest_hire.get(a["req"])
        if cur is None or a["hire_date"] < cur:
            earliest_hire[a["req"]] = a["hire_date"]
    for req in reqs:
        req["open_date"] = earliest_hire[req["id"]] - dt.timedelta(days=R.randint(r, 75, 120))
        tz = loc_by_id[req["loc"]].timezone
        opened_at = local_instant(req["open_date"], 10 * 3600 + R.randint(r, 0, 3599), tz)
        t["requisitions"].rows.append(
            [req["id"], req["dept"], req["loc"], req["title"], req["openings"], opened_at]
        )
    req_by_id = {req["id"]: req for req in reqs}

    # ---- stage timelines
    r = R.make(_seed(seed, 2))
    for a in apps:
        req = req_by_id[a["req"]]
        tz = loc_by_id[req["loc"]].timezone
        stages = S.PATHS[a["path"]]
        days: dict[str, dt.date] = {}
        if a["path"] == "P5":
            hire = a["hire_date"]
            days["offer"] = hire - dt.timedelta(days=R.randint(r, 14, 28))
            days["onsite"] = days["offer"] - dt.timedelta(days=R.randint(r, 4, 14))
            days["screen"] = days["onsite"] - dt.timedelta(days=R.randint(r, 4, 14))
            days["applied"] = days["screen"] - dt.timedelta(days=R.randint(r, 2, 10))
            days["hired"] = hire
        else:
            days["applied"] = req["open_date"] + dt.timedelta(days=R.randint(r, 1, 30))
            prev = days["applied"]
            for stage in stages[1:]:
                if stage == "withdrawn":
                    gap = R.randint(r, 1, 20)
                elif stage in ("screen", "rejected", "declined"):
                    gap = R.randint(r, 2, 10)
                else:  # onsite, offer
                    gap = R.randint(r, 4, 14)
                prev = prev + dt.timedelta(days=gap)
                days[stage] = prev
        instants: dict[str, dt.datetime] = {}
        for stage in stages:
            system = S.STAGE_SOURCE_SYSTEM[stage]
            if system == "careers_site":
                instants[stage] = utc_instant(days[stage], R.randint(r, 0, 86_399))
            elif system == "recruiter_tool":
                secs = S.RECRUITER_DAY_START_HOUR * 3600 + R.randint(r, 0, S.RECRUITER_DAY_HOURS * 3600 - 1)
                instants[stage] = local_instant(days[stage], secs, tz)
            else:  # hris batch job at 00:05 local on the hire date
                hh = S.HRIS_HIRED_LOCAL_TIME
                instants[stage] = local_instant(days[stage], hh.hour * 3600 + hh.minute * 60, tz)
        a["instants"] = instants

    # ---- candidates: offer-stage applications get distinct one-time candidates
    r = R.make(_seed(seed, 3))
    single = list(range(S.REPEAT_CANDIDATES + 1, S.CANDIDATES + 1))
    R.shuffle(r, single)
    offer_apps = [a for a in apps if a["path"] in ("P4", "P5")]
    for a, cand in zip(offer_apps, single[: len(offer_apps)], strict=True):
        a["candidate"] = cand
    rest = single[len(offer_apps) :] + list(range(1, S.REPEAT_CANDIDATES + 1)) * 2
    R.shuffle(r, rest)
    other_apps = [a for a in apps if a["path"] not in ("P4", "P5")]
    for a, cand in zip(other_apps, rest, strict=True):
        a["candidate"] = cand

    channels = ("careers_site", "referral", "agency", "sourced")
    first_applied: dict[int, dt.datetime] = {}
    for a in apps:
        applied_at = a["instants"]["applied"]
        t["applications"].rows.append([a["id"], a["candidate"], a["req"], R.choice(r, channels), applied_at])
        prev = first_applied.get(a["candidate"])
        if prev is None or applied_at < prev:
            first_applied[a["candidate"]] = applied_at

    cand_names: dict[int, tuple[str, str]] = {}
    for cid in range(1, S.CANDIDATES + 1):
        first = R.choice(r, FIRST_NAMES)
        last = R.choice(r, LAST_NAMES)
        cand_names[cid] = (first, last)
        email = f"{first.lower()}.{last.lower()}.{cid}@example.com"
        phone = f"+1-555-{R.randint(r, 100, 999)}-{R.randint(r, 1000, 9999)}"
        created_at = first_applied[cid] - dt.timedelta(seconds=R.randint(r, 60, 86_400))
        t["candidates"].rows.append([cid, first, last, email, phone, created_at])

    # ---- stage events, offers, hires
    event_id = 0
    offer_id = 0
    for a in apps:
        for stage in S.PATHS[a["path"]]:
            event_id += 1
            t["stage_events"].rows.append(
                [event_id, a["id"], S.STAGE_LABELS[stage], a["instants"][stage], S.STAGE_SOURCE_SYSTEM[stage]]
            )
        if a["path"] in ("P4", "P5"):
            offer_id += 1
            offered_at = a["instants"]["offer"]
            if a["path"] == "P5":
                status = "accepted"
                responded_at = offered_at + dt.timedelta(days=R.randint(r, 1, 5))
            else:
                status = "declined"
                responded_at = a["instants"]["declined"]
            t["offers"].rows.append([offer_id, a["id"], status, offered_at, responded_at])
    for hire_id, a in enumerate(hired_apps, start=1):
        t["hires"].rows.append([hire_id, a["id"], a["employee_id"], a["hire_date"]])

    # ---- employees
    r = R.make(_seed(seed, 4))
    birth_lo = dt.date(1960, 1, 1)
    birth_span = (dt.date(2002, 12, 31) - birth_lo).days
    employees: list[dict[str, Any]] = []
    for emp_id in range(1, S.COHORT_A + S.COHORT_B + 1):
        cohort = "A" if emp_id <= S.COHORT_A else "B"
        first = R.choice(r, FIRST_NAMES)
        last = R.choice(r, LAST_NAMES)
        hire_idx = R.randint(r, 0, INDEX_2025_01 - 1)  # 2015-01 .. 2024-12
        employees.append(
            {
                "id": emp_id,
                "cohort": cohort,
                "first": first,
                "last": last,
                "hire_idx": hire_idx,
                "hire_date": month_index_to_date(hire_idx),
                "termination": S.LEAVER_TERMINATION if cohort == "B" else None,
                "loc": R.randint(r, 1, len(S.LOCATIONS)),
                "dept": R.randint(r, 1, len(S.DEPARTMENTS)),
            }
        )
    for a in hired_apps:
        req = req_by_id[a["req"]]
        first, last = cand_names[a["candidate"]]
        employees.append(
            {
                "id": a["employee_id"],
                "cohort": "C",
                "first": first,
                "last": last,
                "hire_idx": month_index(a["hire_date"]),
                "hire_date": a["hire_date"],
                "termination": None,
                "loc": req["loc"],
                "dept": req["dept"],
                "title": req["title"],
            }
        )
    employees.sort(key=lambda e: e["id"])
    for e in employees:
        birth = birth_lo + dt.timedelta(days=R.randint(r, 0, birth_span))
        email = f"{e['first'].lower()}.{e['last'].lower()}.{e['id']}@example.com"
        t["employees"].rows.append(
            [e["id"], e["first"], e["last"], email, birth, e["hire_date"], e["termination"]]
        )

    # ---- job assignments (half-open, contiguous)
    r = R.make(_seed(seed, 5))
    assignment_id = 0
    for e in employees:
        if e["cohort"] == "A":
            changes = sorted(R.sample(r, range(e["hire_idx"] + 1, INDEX_2025_12 + 1), 2))
            bounds = [e["hire_date"]] + [month_index_to_date(c) for c in changes] + [None]
        elif e["cohort"] == "B":
            change = R.randint(r, e["hire_idx"] + 1, INDEX_2025_06)
            bounds = [e["hire_date"], month_index_to_date(change), S.LEAVER_INTERVAL_END]
        else:
            bounds = [e["hire_date"], None]
        dept = e["dept"]
        level = R.randint(r, 1, 3)
        title = e.get("title") or R.choice(r, S.JOB_TITLES[dept])
        for i in range(len(bounds) - 1):
            if i > 0:
                level += 1
                if R.chance(r, 1, 4):
                    dept = R.randint(r, 1, len(S.DEPARTMENTS))
                title = R.choice(r, S.JOB_TITLES[dept])
            assignment_id += 1
            t["job_assignments"].rows.append(
                [assignment_id, e["id"], dept, e["loc"], title, level, bounds[i], bounds[i + 1]]
            )

    # ---- compensation intervals
    r = R.make(_seed(seed, 6))
    comp_by_emp: dict[int, list[tuple[dt.date, dt.date | None, int]]] = {}
    compensation_id = 0
    for e in employees:
        currency = loc_by_id[e["loc"]].currency
        lo, hi = S.SALARY_RANGE_MAJOR[currency]
        base = R.randint(r, lo * 100, hi * 100)
        if e["cohort"] == "A":
            bp = R.randint(r, *S.MERIT_BP_RANGE)
            raised = base + base * bp // 10_000
            intervals = [(e["hire_date"], S.MERIT_DATE, base), (S.MERIT_DATE, None, raised)]
        elif e["cohort"] == "B":
            intervals = [(e["hire_date"], S.LEAVER_INTERVAL_END, base)]
        else:
            intervals = [(e["hire_date"], None, base)]
        comp_by_emp[e["id"]] = intervals
        e["currency"] = currency
        for valid_from, valid_to, amount in intervals:
            compensation_id += 1
            t["compensation"].rows.append([compensation_id, e["id"], currency, amount, valid_from, valid_to])

    # ---- FX rates: bounded integer random walk, never repeating on consecutive days
    r = R.make(_seed(seed, 7))
    for currency in S.CURRENCIES:
        base = S.FX_BASE_MICROS[currency]
        lo_clamp, hi_clamp = base - base // S.FX_CLAMP_DIVISOR, base + base // S.FX_CLAMP_DIVISOR
        prev = base
        for d in range(S.CALENDAR_DAYS):
            day = S.CALENDAR_START + dt.timedelta(days=d)
            if currency == "USD":
                cur = base
            elif d == 0:
                cur = base
            else:
                step_ppm = R.randint(r, -S.FX_MAX_STEP_PPM, S.FX_MAX_STEP_PPM)
                cur = prev + prev * step_ppm // 1_000_000
                cur = min(max(cur, lo_clamp), hi_clamp)
                if cur == prev:
                    direction = 1 if step_ppm >= 0 else -1
                    cur = prev + direction
                    if not lo_clamp <= cur <= hi_clamp:
                        cur = prev - direction
            t["fx_rates"].rows.append([currency, day, fx_micros_to_decimal(cur)])
            prev = cur

    # ---- payroll: one line per employee per active month, gross = round_half_up(base / 12)
    r = R.make(_seed(seed, 8))
    payroll_line_id = 0
    for e in employees:
        if e["cohort"] == "A":
            months = range(1, 13)
        elif e["cohort"] == "B":
            months = range(1, 7)
        else:
            months = range(e["hire_date"].month, 13)
        for m in months:
            first_of_month = dt.date(2025, m, 1)
            base = next(
                amount
                for valid_from, valid_to, amount in comp_by_emp[e["id"]]
                if valid_from <= first_of_month and (valid_to is None or first_of_month < valid_to)
            )
            gross = (base + 6) // 12
            paid_at = utc_instant(dt.date(2025, m, 25), 17 * 3600 + R.randint(r, 0, 3599))
            payroll_line_id += 1
            t["payroll_lines"].rows.append(
                [payroll_line_id, e["id"], first_of_month, e["currency"], gross, paid_at]
            )

    return Dataset(seed=seed, tables=t)


# --------------------------------------------------------------------------- canonical rendering and output


def _render(value: Any, kind: str) -> str:
    if value is None:
        return ""
    if kind == "ts":
        if not isinstance(value, dt.datetime) or value.tzinfo is None:
            raise TypeError(f"naive or non-datetime instant: {value!r}")
        return value.astimezone(UTC).isoformat(timespec="microseconds")
    if kind == "date":
        return value.isoformat()
    if kind == "rate":
        return format(Decimal(value), ".6f")
    return str(value)


def canonical_csv(table: Table) -> bytes:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow([c for c, _ in table.columns])
    kinds = [k for _, k in table.columns]
    for row in table.rows:
        w.writerow([_render(v, k) for v, k in zip(row, kinds, strict=True)])
    return buf.getvalue().encode("utf-8")


def table_hashes(ds: Dataset) -> dict[str, str]:
    return {name: hashlib.sha256(canonical_csv(tb)).hexdigest() for name, tb in ds.tables.items()}


def arrow_type(kind: str):
    import pyarrow as pa

    return {
        "int": pa.int64(),
        "str": pa.string(),
        "date": pa.date32(),
        "ts": pa.timestamp("us", tz="UTC"),
        "rate": pa.decimal128(18, 6),
    }[kind]


def to_arrow(table: Table):
    import pyarrow as pa

    schema = pa.schema([pa.field(c, arrow_type(k)) for c, k in table.columns])
    cols = list(zip(*table.rows, strict=True)) if table.rows else [() for _ in table.columns]
    arrays = [pa.array(list(col), type=f.type) for col, f in zip(cols, schema, strict=True)]
    return pa.Table.from_arrays(arrays, schema=schema)


def manifest(ds: Dataset) -> dict[str, Any]:
    hashes = table_hashes(ds)
    counts = ds.counts()
    return {
        "seed": ds.seed,
        "generator_version": S.GENERATOR_VERSION,
        "tzdata_version": S.TZDATA_VERSION,
        "tables": {name: {"rows": counts[name], "sha256": hashes[name]} for name in ds.tables},
        "total_rows": sum(counts.values()),
    }


def write_dataset(ds: Dataset, out_dir: Path) -> dict[str, Any]:
    import pyarrow.parquet as pq

    out_dir.mkdir(parents=True, exist_ok=True)
    for name, tb in ds.tables.items():
        pq.write_table(to_arrow(tb), out_dir / f"{name}.parquet")
    m = manifest(ds)
    (out_dir / "manifest.json").write_text(json.dumps(m, indent=2, sort_keys=True) + "\n")
    return m
