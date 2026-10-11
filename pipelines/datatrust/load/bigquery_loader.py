"""Load generated Parquet into BigQuery `datatrust_raw` (SPEC 7.4, 18.1). Implemented, not executed.

After each load the schema is asserted: every `*_at` column must be TIMESTAMP (a DATETIME would fail later in
DATE(ts, tz)), integer minor-unit money INT64, rates NUMERIC and dates DATE (review finding B1)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from datatrust.synth import spec as S
from datatrust.warehouse.bigquery_wh import JOB_ID_PREFIX, JOB_LABELS

EXPECTED_TYPES = {
    "int": {"INTEGER", "INT64"},
    "str": {"STRING"},
    "date": {"DATE"},
    "ts": {"TIMESTAMP"},
    "rate": {"NUMERIC"},
}


class LoadTypeError(RuntimeError):
    pass


def check_schema(
    table: str, fields: list[tuple[str, str]], columns: list[tuple[str, str]] | None = None
) -> list[str]:
    """Problems with a loaded table's (name, BigQuery type) list against the dataset's column kinds."""
    kinds = dict(columns or S.TABLE_COLUMNS[table])
    problems = []
    for name, bq_type in fields:
        kind = kinds.get(name)
        if kind is None:
            problems.append(f"{table}.{name}: unexpected column")
        elif bq_type.upper() not in EXPECTED_TYPES[kind]:
            problems.append(f"{table}.{name}: loaded as {bq_type}, expected {sorted(EXPECTED_TYPES[kind])}")
        if name.endswith("_at") and bq_type.upper() != "TIMESTAMP":
            problems.append(f"{table}.{name}: instants must load as TIMESTAMP")
    return problems


def load_raw_bigquery(
    raw_dir: Path,
    project: str,
    location: str,
    dataset: str = "datatrust_raw",
    client: Any | None = None,
    table_columns: dict[str, list[tuple[str, str]]] | None = None,
) -> dict[str, int]:
    from google.cloud import bigquery

    client = client or bigquery.Client(project=project, location=location)
    counts: dict[str, int] = {}
    for table in S.TABLE_ORDER:
        dest = f"{project}.{dataset}.{table}"
        cfg = bigquery.LoadJobConfig(
            labels=dict(JOB_LABELS),  # load jobs are free; the label attributes them on the shared project
            source_format=bigquery.SourceFormat.PARQUET,
            write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE,
            decimal_target_types=["NUMERIC", "BIGNUMERIC"],
        )
        with (raw_dir / f"{table}.parquet").open("rb") as fh:
            client.load_table_from_file(
                fh, dest, job_config=cfg, location=location, job_id_prefix=JOB_ID_PREFIX
            ).result()
        loaded = client.get_table(dest)
        cols = (table_columns or {}).get(table)
        problems = check_schema(table, [(f.name, f.field_type) for f in loaded.schema], cols)
        if problems:
            raise LoadTypeError("; ".join(problems))
        counts[table] = int(loaded.num_rows or 0)
    return counts
