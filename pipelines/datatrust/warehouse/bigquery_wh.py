"""BigQuery warehouse for probes (SPEC 10, ADR-0007): the impersonated read-only service account
`datatrust-prober`, a free dry run before every query, and `maximum_bytes_billed` on the real one.
Implemented, not executed (no Google Cloud credentials in this repo's CI)."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from datatrust.warehouse.readonly import assert_read_only

PROBE_MAX_BYTES = 100 * 1000 * 1000  # 100 MB per probe; a query over the cap fails without charge
# The Google Cloud project is shared by four repos (SPEC 28.5.10): every DataTrust job carries this label, so
# its bytes can be told apart in INFORMATION_SCHEMA.JOBS_BY_PROJECT, and every query is capped.
JOB_LABELS = {"app": "datatrust"}
# ... and its job ids start with the repo name, like every other DataTrust resource on the shared project.
# dbt-bigquery mints its own uuid4 job ids, so dbt jobs are told apart by the same label instead.
JOB_ID_PREFIX = "datatrust_"


def capped_job_config(max_bytes: int = PROBE_MAX_BYTES, **kwargs: Any):
    """A QueryJobConfig with the DataTrust label and `maximum_bytes_billed` (a capped query fails, free)."""
    from google.cloud import bigquery

    return bigquery.QueryJobConfig(maximum_bytes_billed=max_bytes, labels=dict(JOB_LABELS), **kwargs)


SCOPES = ["https://www.googleapis.com/auth/cloud-platform"]


def impersonated(target_principal: str, quota_project: str | None = None):
    import google.auth
    from google.auth import impersonated_credentials

    source, _ = google.auth.default(scopes=SCOPES)
    return impersonated_credentials.Credentials(
        source_credentials=source,
        target_principal=target_principal,
        target_scopes=SCOPES,
        lifetime=3600,
        quota_project_id=quota_project,
    )


class BigQueryWarehouse:
    dialect = "bigquery"

    def __init__(
        self,
        project: str,
        location: str,
        *,
        client: Any | None = None,
        principal: str | None = None,
        max_bytes: int = PROBE_MAX_BYTES,
    ) -> None:
        if client is None:
            from google.cloud import bigquery

            creds = impersonated(principal, project) if principal else None
            client = bigquery.Client(project=project, credentials=creds, location=location)
        self.client = client
        self.project = project
        self.location = location
        self.max_bytes = max_bytes
        self.bytes_billed = 0
        self.bytes_dry_run = 0
        self._columns: dict[tuple[str, str], set[str]] = {}

    def _config(self, params: Mapping[str, object] | None, *, dry_run: bool):
        from google.cloud import bigquery

        query_params = [bigquery.ScalarQueryParameter(k, "STRING", str(v)) for k, v in (params or {}).items()]
        return capped_job_config(
            self.max_bytes, dry_run=dry_run, use_query_cache=False, query_parameters=query_params
        )

    def _submit(self, sql: str, cfg: Any):
        return self.client.query(sql, job_config=cfg, location=self.location, job_id_prefix=JOB_ID_PREFIX)

    def query(
        self, sql: str, params: Mapping[str, object] | None = None, *, max_rows: int = 1000
    ) -> list[dict]:
        assert_read_only(sql, "bigquery")
        dry = self._submit(sql, self._config(params, dry_run=True))
        self.bytes_dry_run += int(getattr(dry, "total_bytes_processed", 0) or 0)
        job = self._submit(sql, self._config(params, dry_run=False))
        rows = job.result(max_results=max_rows)
        self.bytes_billed += int(getattr(job, "total_bytes_billed", 0) or 0)
        return [dict(r.items()) for r in rows]

    def dry_run(self, sql: str) -> int:
        assert_read_only(sql, "bigquery")
        job = self._submit(sql, self._config(None, dry_run=True))
        return int(getattr(job, "total_bytes_processed", 0) or 0)

    def relation_columns(self, node: Mapping[str, Any]) -> set[str]:
        key = (str(node["schema"]), str(node["identifier"]))
        if key not in self._columns:
            dataset = key[0]
            sql = (
                f"select column_name from `{self.project}.{dataset}`.INFORMATION_SCHEMA.COLUMNS "
                "where table_name = @table_name"
            )
            rows = self.query(sql, {"table_name": key[1]}, max_rows=10_000)
            self._columns[key] = {r["column_name"] for r in rows}
        return self._columns[key]

    def close(self) -> None:
        close = getattr(self.client, "close", None)
        if close:
            close()

    def __enter__(self) -> BigQueryWarehouse:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()
