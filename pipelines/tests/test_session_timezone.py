"""ADR-0006: the dbt DuckDB session runs in UTC whatever the machine zone (SPEC 7.3)."""

from __future__ import annotations

import json
import re

from datatrust.dbt.build import run_dbt


def _show(sql: str, tmp_path, tz: str) -> list[dict]:
    res = run_dbt(
        ["show", "--inline", sql, "--output", "json", "--log-format", "text"],
        target_path=tmp_path / "target",
        duckdb_path=tmp_path / "tz.duckdb",
        env_extra={"TZ": tz},
    )
    assert res.returncode == 0, res.stdout
    match = re.search(r'\{\s*"show"\s*:\s*\[.*?\]\s*\}', res.stdout, re.S)
    assert match, res.stdout
    return json.loads(match.group(0))["show"]


def test_dbt_session_is_utc_under_los_angeles_tz(tmp_path):
    rows = _show(
        "select current_setting('TimeZone') as tz, "
        "cast(cast(TIMESTAMPTZ '2025-06-30 03:00:00+00:00' as date) as varchar) as utc_date, "
        "cast(extract(hour from TIMESTAMPTZ '2025-06-30 03:00:00+00:00') as integer) as utc_hour",
        tmp_path,
        "America/Los_Angeles",
    )
    assert rows == [{"tz": "UTC", "utc_date": "2025-06-30", "utc_hour": 3}]


def test_local_time_macro_is_session_independent(tmp_path):
    sql = (
        "select cast({{ tz_local_hour(\"TIMESTAMPTZ '2025-06-30 03:00:00+00:00'\", \"'Asia/Kolkata'\") }} "
        "as integer) as h, cast({{ tz_local_date(\"TIMESTAMPTZ '2025-06-30 20:00:00+00:00'\", "
        "\"'Asia/Kolkata'\") }} as varchar) as d"
    )
    rows = _show(sql, tmp_path, "America/Los_Angeles")
    assert rows == [{"h": 8, "d": "2025-07-01"}]
