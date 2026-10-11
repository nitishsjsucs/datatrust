"""On clean seed 101, every planned probe runs and reports no anomaly (probe false positives would mislead
the ranker)."""

from __future__ import annotations

from datatrust.diagnostics.probes import ProbeRequest, run_probes
from datatrust.warehouse.duckdb_wh import DuckDBWarehouse


def test_all_planned_probes_clean(built_101, all_planned_probes):
    rel, probes = all_planned_probes
    with DuckDBWarehouse(built_101.duckdb_path) as wh:
        results = run_probes([ProbeRequest.from_json(p) for p in probes], wh, rel)
    not_ok = [(r.probe_id, r.status, r.error) for r in results if r.status != "ok"]
    assert not_ok == []
    anomalous = [(r.probe_id, r.value) for r in results if r.anomaly > 0]
    assert anomalous == []
