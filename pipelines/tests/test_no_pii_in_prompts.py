"""No generated name, email, phone number, birth date or salary amount reaches an LLM prompt or a summary
(SPEC 13.8, ADR-0007). Builds every seed-101 prompt: 20 injected trials through dbt, probes, `rca sanitize`,
evidence and the prompt builder. Marked `bench`; CI runs it in the bench-offline job.
"""

from __future__ import annotations

import re

import pytest

from datatrust.bench.harness import run_bench, trial_specs
from datatrust.synth.generator import generate

pytestmark = pytest.mark.bench


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


@pytest.fixture(scope="module")
def seed101_trials(tmp_path_factory):
    return run_bench(
        trial_specs([101], clean=False), work_dir=tmp_path_factory.mktemp("pii"), workers=4, progress=False
    )


def find_leaks(texts: dict[str, str], pii: dict[str, set[str]]) -> list[tuple[str, str, str]]:
    leaks = []
    for trial, text in texts.items():
        for kind in ("names", "emails", "phones", "birth_dates"):
            for value in pii[kind]:
                if value in text:
                    leaks.append((trial, kind, value))
        for number in re.findall(r"(?<![0-9a-f.])\d{5,}(?:\.\d+)?(?![0-9a-f])", text):
            if number in pii["salaries"]:
                leaks.append((trial, "salary", number))
    return leaks


def test_detector_catches_planted_leaks():
    pii = pii_strings(101)
    name, email, salary = sorted(pii["names"])[0], sorted(pii["emails"])[0], sorted(pii["salaries"])[-1]
    planted = {"t": f"candidate {name} <{email}> earns {salary}"}
    kinds = {k for _, k, _ in find_leaks(planted, pii)}
    assert kinds == {"names", "emails", "salary"}


def test_every_seed101_prompt_and_summary_is_free_of_pii(seed101_trials):
    pii = pii_strings(101)
    texts = {r["trial"]: r["promptText"] + "\n" + r["summaryText"] for r in seed101_trials if r["detected"]}
    assert len(texts) == 20
    assert find_leaks(texts, pii) == []


def test_prompts_cite_evidence_by_placeholder_key(seed101_trials):
    for r in seed101_trials:
        assert "{ev:<key>.<field>}" in r["promptText"]
        assert "fields:" in r["promptText"]
