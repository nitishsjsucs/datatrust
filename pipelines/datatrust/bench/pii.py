"""PII strings of a generated dataset and a leak finder (SPEC 13.8): full names, emails, phone numbers, birth
dates and salary amounts. Used by test_no_pii_in_prompts.py and the summary eval."""

from __future__ import annotations

import re

from datatrust.synth.generator import generate

NUMBER = re.compile(r"(?<![0-9a-f.])\d{5,}(?:\.\d+)?(?![0-9a-f])")


def pii_strings(seed: int) -> dict[str, set[str]]:
    ds = generate(seed)
    out: dict[str, set[str]] = {
        "names": set(),
        "emails": set(),
        "phones": set(),
        "birth_dates": set(),
        "salaries": set(),
    }
    emp = ds["employees"]
    for r in emp.rows:
        out["names"].add(f"{r[emp.col('first_name')]} {r[emp.col('last_name')]}")
        out["emails"].add(r[emp.col("work_email")])
        out["birth_dates"].add(r[emp.col("birth_date")].isoformat())
    cand = ds["candidates"]
    for r in cand.rows:
        out["names"].add(f"{r[cand.col('first_name')]} {r[cand.col('last_name')]}")
        out["emails"].add(r[cand.col("email")])
        out["phones"].add(r[cand.col("phone")])
    comp = ds["compensation"]
    for r in comp.rows:
        minor = r[comp.col("base_salary_local_minor")]
        out["salaries"].update({str(minor), f"{minor / 100:.2f}", f"{minor // 100}"})
    pay = ds["payroll_lines"]
    for r in pay.rows:
        out["salaries"].add(str(r[pay.col("gross_pay_local_minor")]))
    return out


def find_leaks(texts: dict[str, str], pii: dict[str, set[str]]) -> list[tuple[str, str, str]]:
    leaks = []
    for key, text in texts.items():
        for kind in ("names", "emails", "phones", "birth_dates"):
            for value in pii[kind]:
                if value in text:
                    leaks.append((key, kind, value))
        for number in NUMBER.findall(text):
            if number in pii["salaries"]:
                leaks.append((key, "salary", number))
    return leaks
