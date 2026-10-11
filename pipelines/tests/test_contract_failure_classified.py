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


def test_database_errors_never_carry_values_into_check_results(parsed_manifest):
    """A runtime error on bad data quotes the value (DuckDB's ConversionException, BigQuery's "Bad int64
    value"); only the error class may reach the Worker, D1, R2 and the incident JSON viewers read."""
    from datatrust.checks.results import safe_message
    from datatrust.runner.loop import _slim_run_results

    leak = "85,000"
    rr = {
        "results": [
            {
                "unique_id": "model.datatrust.stg_compensation",
                "status": "error",
                "message": "Runtime Error in model stg_compensation (models/staging/stg_compensation.sql)\n"
                f"  Conversion Error: Could not convert string '{leak}' to INT64 when casting from column x",
            },
            {
                "unique_id": next(
                    u for u, n in parsed_manifest["nodes"].items() if n["resource_type"] == "test"
                ),
                "status": "error",
                "message": f"Database Error in test x (tests/x.sql)\n  Bad int64 value: {leak}",
            },
        ]
    }
    results = classify(rr, parsed_manifest)
    by_kind = {r.kind: r for r in results}
    assert by_kind["model_error"].message == "Conversion Error"
    assert by_kind["data_test"].message == "Database Error"
    assert leak not in json.dumps([r.to_json() for r in results])
    assert leak not in json.dumps(_slim_run_results(rr))
    # What stays: dbt's count line, and the contract marker with column names only.
    assert safe_message("Got 3 results, configured to fail if != 0", "fail") == (
        "Got 3 results, configured to fail if != 0"
    )
    assert safe_message("Got 3 results, configured to fail if != 0 'x'", "fail") == "Error"
    contract = json.loads(FIXTURE.read_text())["results"]
    msg = next(r["message"] for r in contract if r["status"] == "error")
    assert safe_message(msg, "error") == f"{CONTRACT_MARKER}: base_salary_local_minor"
    assert safe_message("OK created table", "success") is None
