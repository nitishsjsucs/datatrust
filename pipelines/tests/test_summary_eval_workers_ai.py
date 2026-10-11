"""Resumable Workers AI summary eval (SPEC 12.4, 28.5.5, stretch): stops for the day when the neuron ledger
has less than one incident's worst case left, resumes from the checkpoint, and reports neurons per UTC day.
Offline: a fake client stands in for the deployed Worker."""

from __future__ import annotations

import json
from types import SimpleNamespace

from datatrust.bench.summaries import NEURONS_PER_INCIDENT_MAX, evaluate_workers_ai, write_summary_report

NO_PII = {"names": set(), "emails": set(), "phones": set(), "birth_dates": set(), "salaries": set()}


def _trials(n: int) -> list[dict]:
    return [
        {
            "trial": f"101-S{i:02d}",
            "scenario": f"S{i:02d}",
            "groundTruth": "source.datatrust.raw.hires",
            "evidence": {
                "candidates": [{"node": "source.datatrust.raw.hires"}, {"node": "model.datatrust.stg_hires"}]
            },
        }
        for i in range(1, n + 1)
    ]


class FakeWorker:
    """The deployed Worker: a 2,000-neuron daily cap; each incident uses 300 and reserves up to 388."""

    def __init__(self, day: str, refuse_after: int | None = None):
        self.day, self.reserved, self.posts, self.refuse_after = day, 0, 0, refuse_after

    def ai_budget(self):
        return {"day": self.day, "cap": 2000, "reserved": self.reserved, "headroom": 2000 - self.reserved}

    def request(self, method, path, json=None):
        assert (method, path) == ("POST", "/api/eval/summary") and "evidence" in json
        self.posts += 1
        if self.refuse_after is not None and self.posts > self.refuse_after:
            return SimpleNamespace(json=lambda: {"refused": True, "day": self.day})
        self.reserved += 300
        out = {
            "refused": False,
            "day": self.day,
            "provider": "workers-ai",
            "model": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            "attempts": 1,
            "firstDraftJson": True,
            "firstDraftGrounded": True,
            "repaired": False,
            "fallback": False,
            "violations": [],
            "draft": {"suspectedRootCause": {"node": "source.datatrust.raw.hires"}},
            "summary": {"title": "U05 traced to raw_hires"},
            "rawDrafts": ['{"title": "x"}'],
            "neurons": {"reserved": 300, "used": 300},
        }
        return SimpleNamespace(json=lambda: out)


def test_stops_at_the_daily_cap_and_resumes_from_the_checkpoint(tmp_path):
    cp = tmp_path / "summaries-workers-ai.checkpoint.jsonl"
    trials = _trials(8)
    day1 = FakeWorker("2026-10-11")
    first = evaluate_workers_ai(101, day1, cp, trials=trials, pii=NO_PII)
    # 2,000 neurons: six incidents leave 200 of headroom, below one incident's worst case.
    assert first == {"done": 6, "total": 8, "stopped": first["stopped"]}
    assert "resume after 00:00 UTC" in first["stopped"] and day1.posts == 6
    assert 2000 - 6 * 300 < NEURONS_PER_INCIDENT_MAX
    assert len(cp.read_text().splitlines()) == 6

    day2 = FakeWorker("2026-10-12")
    second = evaluate_workers_ai(101, day2, cp, trials=trials, pii=NO_PII)
    assert (second["done"], second["stopped"], day2.posts) == (8, None, 2)
    report = second["report"]
    assert report["summary"]["incidents"] == 8 and report["summary"]["groundingPassRate"] == 1.0
    assert report["summary"]["neuronsPerDay"] == {
        "2026-10-11": {"incidents": 6, "reserved": 1800, "used": 1800},
        "2026-10-12": {"incidents": 2, "reserved": 600, "used": 600},
    }
    assert [r["trial"] for r in report["rows"]] == [t["trial"] for t in trials]
    _, md = write_summary_report(report, tmp_path, "uv run datatrust bench summaries --provider workers-ai")
    assert "Workers AI neurons per UTC day: 2026-10-11 6 incidents, 1800 used" in md.read_text()

    # Nothing left: a rerun posts nothing and reports again.
    day3 = FakeWorker("2026-10-13")
    assert evaluate_workers_ai(101, day3, cp, trials=trials, pii=NO_PII)["done"] == 8 and day3.posts == 0


def test_a_refused_call_stops_without_checkpointing_that_incident(tmp_path):
    cp = tmp_path / "cp.jsonl"
    out = evaluate_workers_ai(
        101, FakeWorker("2026-10-11", refuse_after=2), cp, trials=_trials(4), pii=NO_PII
    )
    assert out["done"] == 2 and "neuron cap refused" in out["stopped"]
    assert [json.loads(line)["trial"] for line in cp.read_text().splitlines()] == ["101-S01", "101-S02"]
