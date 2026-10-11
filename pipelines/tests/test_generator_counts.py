"""Exact row counts and structural invariants of the synthetic dataset (SPEC 6.3 to 6.6)."""

from __future__ import annotations

import datetime as dt
from collections import Counter, defaultdict

import pytest

from datatrust.synth import spec as S

SEEDS = [1, 2, 3, 101, 105, 987654]


def rows(ds, table):
    t = ds[table]
    names = [c for c, _ in t.columns]
    return [dict(zip(names, r, strict=True)) for r in t.rows]


@pytest.mark.parametrize("seed", SEEDS)
def test_exact_counts(dataset_factory, seed):
    ds = dataset_factory(seed)
    assert ds.counts() == S.EXPECTED_COUNTS
    assert sum(ds.counts().values()) == 43_190


@pytest.mark.parametrize("seed", [1, 101])
def test_cohorts_and_paths(dataset_factory, seed):
    ds = dataset_factory(seed)
    emps = rows(ds, "employees")
    assert sum(1 for e in emps if e["termination_date"] == dt.date(2025, 6, 30)) == 60
    hires_2025 = Counter(e["hire_date"].month for e in emps if e["hire_date"].year == 2025)
    assert hires_2025 == {m: 30 for m in range(1, 13)}
    assert all(e["hire_date"].day == 1 for e in emps)
    assert all(e["work_email"].endswith("@example.com") for e in emps)

    paths = defaultdict(list)
    for ev in rows(ds, "stage_events"):
        paths[ev["application_id"]].append(ev["stage"])
    path_counts = Counter(tuple(v) for v in paths.values())
    expected = {
        S.PATHS["P1"]: 2_400,
        S.PATHS["P2"]: 1_200,
        S.PATHS["P3"]: 600,
        S.PATHS["P4"]: 120,
        S.PATHS["P5"]: 360,
        S.PATHS["P6"]: 120,
    }
    assert path_counts == expected

    per_req = Counter(a["requisition_id"] for a in rows(ds, "applications"))
    assert set(per_req.values()) == {20}
    cand = Counter(a["candidate_id"] for a in rows(ds, "applications"))
    assert sum(1 for c, n in cand.items() if n == 2) == 1_200
    assert all(n == 2 for c, n in cand.items() if c <= 1_200)
    assert all(n == 1 for c, n in cand.items() if c > 1_200)
    offers = Counter(o["offer_status"] for o in rows(ds, "offers"))
    assert offers == {"accepted": 360, "declined": 120}


@pytest.mark.parametrize("seed", [2, 101])
def test_intervals_contiguous_and_half_open(dataset_factory, seed):
    ds = dataset_factory(seed)
    emp = {e["employee_id"]: e for e in rows(ds, "employees")}
    for table in ("job_assignments", "compensation"):
        by_emp = defaultdict(list)
        for r in rows(ds, table):
            by_emp[r["employee_id"]].append(r)
        assert len(by_emp) == 1_200
        for emp_id, ivs in by_emp.items():
            ivs.sort(key=lambda r: r["valid_from"])
            assert ivs[0]["valid_from"] == emp[emp_id]["hire_date"]
            for a, b in zip(ivs, ivs[1:], strict=False):
                assert a["valid_to"] == b["valid_from"]
            last = ivs[-1]["valid_to"]
            if emp[emp_id]["termination_date"] is None:
                assert last is None
            else:
                assert last == emp[emp_id]["termination_date"] + dt.timedelta(days=1)


@pytest.mark.parametrize("seed", [3, 101])
def test_fx_walk(dataset_factory, seed):
    ds = dataset_factory(seed)
    by_cur = defaultdict(list)
    for r in rows(ds, "fx_rates"):
        by_cur[r["currency"]].append(r)
    assert sorted(by_cur) == ["CAD", "EUR", "GBP", "INR", "SGD", "USD"]
    for cur, series in by_cur.items():
        assert [r["rate_date"] for r in series] == [
            dt.date(2025, 1, 1) + dt.timedelta(days=i) for i in range(365)
        ]
        values = [r["rate_to_usd"] for r in series]
        if cur == "USD":
            assert set(values) == {1}
            continue
        assert all(a != b for a, b in zip(values, values[1:], strict=False)), cur
        base = S.FX_BASE_MICROS[cur] / 1e6
        assert all(abs(float(v) / base - 1) <= 0.1000001 for v in values)


@pytest.mark.parametrize("seed", [1, 101])
def test_payroll_rule_and_instants(dataset_factory, seed):
    ds = dataset_factory(seed)
    comp = defaultdict(list)
    for c in rows(ds, "compensation"):
        comp[c["employee_id"]].append(c)
    for line in rows(ds, "payroll_lines"):
        day = line["pay_month"]
        assert day.day == 1 and day.year == 2025
        base = next(
            c["base_salary_local_minor"]
            for c in comp[line["employee_id"]]
            if c["valid_from"] <= day and (c["valid_to"] is None or day < c["valid_to"])
        )
        assert line["gross_pay_local_minor"] == (base + 6) // 12
    for name, cols in S.TABLE_COLUMNS.items():
        ts_cols = [c for c, k in cols if k == "ts"]
        for r in rows(ds, name):
            for c in ts_cols:
                assert r[c].utcoffset() == dt.timedelta(0), (name, c)


def test_seed_changes_values_not_counts(dataset_factory):
    a, b = dataset_factory(1), dataset_factory(2)
    assert a.counts() == b.counts()
    assert a["employees"].rows != b["employees"].rows
