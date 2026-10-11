"""A recorded dbt-duckdb contract failure is classified as schema_contract with the column (SPEC 7.2)."""

from __future__ import annotations

import json
from pathlib import Path

from datatrust.checks.results import CONTRACT_MARKER, classify, contract_columns

FIXTURE = Path(__file__).parent / "fixtures" / "run_results_contract_failure.json"


def test_fixture_is_a_real_contract_failure():
    rr = json.loads(FIXTURE.read_text())
    errors = [r for r in rr["results"] if r["status"] == "error"]
    assert [r["unique_id"] for r in errors] == ["model.datatrust.stg_compensation"]
    assert CONTRACT_MARKER in errors[0]["message"]


def test_contract_failure_classified(parsed_manifest):
    rr = json.loads(FIXTURE.read_text())
    results = classify(rr, parsed_manifest)
    contract = [r for r in results if r.kind == "schema_contract"]
    assert len(contract) == 1
    c = contract[0]
    assert c.checkId == "schema_contract:stg_compensation"
    assert c.node == "model.datatrust.stg_compensation"
    assert c.columns == ["base_salary_local_minor"]
    assert c.status == "error"
    skipped = {r.checkId for r in results if r.status == "skip"}
    assert {"U02", "C01", "C02", "X01"} <= skipped


def test_contract_table_parser_ignores_header_and_separator():
    msg = (
        "| column_name | definition_type | contract_type | mismatch_reason |\n"
        "| ----------- | --------------- | ------------- | --------------- |\n"
        "| amount      | VARCHAR         | BIGINT        | data type mismatch |\n"
    )
    assert contract_columns(msg) == ["amount"]
