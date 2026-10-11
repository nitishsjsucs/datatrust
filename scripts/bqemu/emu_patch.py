"""Loaded only inside the bq-emulator-check container (through a .pth file in its own virtualenv): work around
two goccy BigQuery emulator gaps that real BigQuery does not have. Never imported by DataTrust itself."""

try:
    import types

    from google.cloud import bigquery

    # routines.list is not implemented by the emulator (dbt-bigquery 1.12 lists UDFs with every dataset)
    bigquery.Client.list_routines = lambda self, *a, **k: iter(())
    # query jobs come back without the anonymous destination table that BigQuery always sets
    _get_table = bigquery.Client.get_table

    def _get_table_or_stub(self, table, *a, **k):
        if table is None:
            return types.SimpleNamespace(num_rows=None)
        return _get_table(self, table, *a, **k)

    bigquery.Client.get_table = _get_table_or_stub
except Exception:  # noqa: BLE001
    pass
