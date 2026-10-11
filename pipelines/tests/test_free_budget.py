"""The Workers Free plan budget model (SPEC 28.6, 28.7): counts derived from the code and fixtures, and the
production smoke inside DataTrust's 25% share of every account-wide daily allowance."""

from __future__ import annotations

import math

from datatrust.prod import free_budget as fb
from datatrust.runner.client import LINEAGE_POST_MAX_BYTES, LINEAGE_POST_MAX_EVENTS


def test_allowances_are_the_free_plan_values_with_their_sources():
    assert fb.SHARE == 0.25
    expected = {
        "requests": 100_000,
        "queue_ops": 10_000,
        "workflow_steps": 3_000,
        "d1_rows_written": 100_000,
        "d1_rows_read": 5_000_000,
        "neurons": 10_000,
        "logs": 200_000,
        "r2_class_a": 1_000_000,
        "r2_class_b": 10_000_000,
        "r2_storage_mb": 10_000,
    }
    assert {k: a.amount for k, a in fb.ALLOWANCES.items()} == expected
    assert all(a.url.startswith("https://developers.cloudflare.com/") for a in fb.ALLOWANCES.values())
    assert fb.D1_QUERIES_PER_INVOCATION == 50 and fb.CPU_MS_PER_INVOCATION == 10


def test_per_run_counts_come_from_the_code():
    # 29 models and 40 checks, START and COMPLETE each, plus the job's pair: what dbt-ol wrote for seed 101.
    assert fb.lineage_events_per_run() == 140
    assert (LINEAGE_POST_MAX_EVENTS, LINEAGE_POST_MAX_BYTES) == (10, 262_144)
    # The 10 largest seed-101 events are far below one POST's byte limit, so the count limit decides.
    assert 10 * fb.MEASURED["largest_event_bytes"] < LINEAGE_POST_MAX_BYTES
    f, c = fb.per_run(True), fb.per_run(False)
    assert f.lineage_posts == 14
    # 1 check-results + 14 lineage bundles + 1 investigate + 3 audit messages, 3 operations each.
    assert (f.queue_messages, f.queue_ops) == (19, 57)
    assert (c.queue_messages, c.queue_ops) == (17, 51)
    assert (f.workflow_steps_typical, f.workflow_steps_worst) == (17, 35)
    assert set(fb.VALIDATION_STEPS_FAILING) | set(fb.INVESTIGATION_STEPS) <= fb.workflow_step_names()
    assert "summarize-repair" in fb.workflow_step_names()


def test_consumer_settings_in_the_production_template_match_the_model():
    consumers = {c["queue"]: c for c in fb.production_config()["queues"]["consumers"]}
    assert consumers["datatrust-lineage-events"]["max_batch_size"] == 1  # one bundle per invocation
    assert consumers["datatrust-check-results"]["max_batch_size"] == 10  # at most 10 upserts per invocation
    assert (
        consumers["datatrust-audit-events"]["max_batch_size"],
        consumers["datatrust-audit-events"]["max_batch_timeout"],
    ) == (10, 30)
    assert fb.ai_daily_neuron_cap() == 2000


def test_idle_runner_polls_at_most_2880_times_a_day():
    assert fb.idle_polls(86_400) <= 2_880 + 5
    assert fb.idle_polls(60) == 5  # 2 + 4 + 8 + 16 + 30


def test_workers_ai_reservation_matches_the_worker():
    assert fb.reservation_neurons(fb.MEASURED["largest_prompt_chars"]) == 187
    assert fb.reservation_neurons(fb.MEASURED["largest_repair_prompt_chars"]) == 201
    assert 5 * (187 + 201) == 1940  # the smoke's headroom check (prod/smoke.py SMOKE_NEURON_HEADROOM)


def test_the_smoke_fits_the_share():
    """SPEC 28.1 margin rule: the smoke uses at most 50% of DataTrust's share of every daily allowance in the
    expected case; Workers AI's worst case may pass 50% but stays under the code-enforced cap."""
    lines = fb.smoke_lines()
    cap = fb.ai_daily_neuron_cap()
    for x in lines:
        if x.key == "neurons" and x.worst:
            assert x.smoke <= cap <= x.share, x
        else:
            assert x.pct_of_share <= 50.0, x
    by = {(x.key, x.worst): x for x in lines}
    assert by[("requests", False)].smoke <= 0.5 * 25_000
    assert by[("queue_ops", False)].smoke == 5 * 57 + 51 == 336
    assert math.isclose(by[("queue_ops", False)].pct_of_share, 13.44)


def test_sustained_rate_is_about_20_runs_per_day():
    assert 20 <= fb.sustained_runs_per_day() <= 25
    table = fb.markdown()
    assert "| Queue operations | 10,000 per day | 2,500 | 57 | 336 | 13.4% |" in table
