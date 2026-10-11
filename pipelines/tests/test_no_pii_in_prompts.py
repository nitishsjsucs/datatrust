"""No generated name, email, phone number, birth date or salary amount reaches an LLM prompt or a summary
(SPEC 13.8, ADR-0007). Builds every seed-101 prompt: 20 injected trials through dbt, probes, `rca sanitize`,
evidence and the prompt builder. Marked `bench`; CI runs it in the bench-offline job.
"""

from __future__ import annotations

import pytest

from datatrust.bench.harness import run_bench, trial_specs
from datatrust.bench.pii import find_leaks, pii_strings

pytestmark = pytest.mark.bench


@pytest.fixture(scope="module")
def seed101_trials(tmp_path_factory):
    return run_bench(
        trial_specs([101], clean=False), work_dir=tmp_path_factory.mktemp("pii"), workers=4, progress=False
    )


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
