"""The JSON Schemas in schemas/api/ describe what the runner and the Worker actually exchange (SPEC 5, 13.1):
real check results, sanitized probe results and job payloads validate against them, and the ranker's input
cannot carry ground truth (SPEC 11)."""

from __future__ import annotations

import json

import jsonschema
import pytest

from datatrust import config
from datatrust.diagnostics.probes import ProbeRequest, run_probes
from datatrust.rca_cli import RcaCliError, rca
from datatrust.warehouse.duckdb_wh import DuckDBWarehouse

SCHEMAS = config.REPO_ROOT / "schemas" / "api"


def schema(name: str) -> dict:
    s = json.loads((SCHEMAS / f"{name}.json").read_text())
    jsonschema.Draft202012Validator.check_schema(s)
    return s


def test_check_results_match_the_schema(built_101_results):
    s = schema("check_result")
    for r in built_101_results:
        jsonschema.validate(r.to_json(), s)


def test_contract_failure_matches_the_schema(parsed_manifest):
    from pathlib import Path

    from datatrust.checks.results import classify

    rr = json.loads((Path(__file__).parent / "fixtures" / "run_results_contract_failure.json").read_text())
    s = schema("check_result")
    for r in classify(rr, parsed_manifest):
        jsonschema.validate(r.to_json(), s)


def test_sanitized_probe_results_match_the_schema(built_101, all_planned_probes):
    rel, probes = all_planned_probes
    with DuckDBWarehouse(built_101.duckdb_path) as wh:
        raw = [r.to_json() for r in run_probes([ProbeRequest.from_json(p) for p in probes[:40]], wh, rel)]
    sanitized = rca(
        "sanitize",
        {"probeResults": raw, "relations": rel},
        env_extra={"EVIDENCE_HMAC_KEY": "schema-test-key-0123456789"},
    )["probeResults"]
    s = schema("probe_result")
    for r in sanitized:
        jsonschema.validate(r, s)


def test_job_payloads_match_the_schema(all_planned_probes):
    _, probes = all_planned_probes
    s = schema("runner_job")
    base = {"jobId": "job_x", "runId": "run_x", "leaseToken": "a" * 48, "leaseExpiresAt": 1, "attempts": 1}
    jsonschema.validate(
        {
            **base,
            "kind": "dbt_build",
            "payload": {"runId": "run_x", "target": "duckdb", "seed": 101, "scenario": "S01"},
        },
        s,
    )
    jsonschema.validate(
        {
            **base,
            "kind": "diagnostics",
            "payload": {"runId": "run_x", "incidentId": "inc_x", "target": "duckdb", "probes": probes},
        },
        s,
    )
    with pytest.raises(jsonschema.ValidationError):
        bad = [{**probes[0], "sql": "select 1"}]
        jsonschema.validate(
            {
                **base,
                "kind": "diagnostics",
                "payload": {"runId": "r", "incidentId": "i", "target": "duckdb", "probes": bad},
            },
            s,
        )


def test_incident_summary_schema_is_the_generated_one():
    assert schema("incident_summary") == rca("schema", {})


def test_ranker_input_cannot_carry_ground_truth():
    with pytest.raises(RcaCliError, match="unexpected input"):
        rca(
            "rank",
            {
                "checks": [],
                "events": [],
                "relations": {"project": "p", "dialect": "duckdb", "nodes": {}},
                "scenario": "S01",
            },
        )
