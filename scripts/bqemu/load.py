"""Create the four DataTrust datasets and the 13 raw tables (BigQuery types, no rows) in the emulator."""

import sys

from google.api_core.client_options import ClientOptions
from google.auth.credentials import AnonymousCredentials
from google.cloud import bigquery

from datatrust.synth import spec as S

TYPES = {"int": "INT64", "str": "STRING", "date": "DATE", "ts": "TIMESTAMP", "rate": "NUMERIC"}
client = bigquery.Client(
    project="datatrust-emu",
    credentials=AnonymousCredentials(),
    client_options=ClientOptions(api_endpoint=sys.argv[1]),
)
for ds in ("datatrust_raw", "datatrust_staging", "datatrust_marts", "datatrust_restricted"):
    try:
        client.get_dataset(f"datatrust-emu.{ds}", retry=None)
    except Exception:  # noqa: BLE001 - the emulator answers 500, not 409, for an existing dataset
        client.create_dataset(bigquery.Dataset(f"datatrust-emu.{ds}"), retry=None)
for table in S.TABLE_ORDER:
    ref = f"datatrust-emu.datatrust_raw.{table}"
    client.delete_table(ref, not_found_ok=True)
    client.create_table(
        bigquery.Table(ref, schema=[bigquery.SchemaField(n, TYPES[k]) for n, k in S.TABLE_COLUMNS[table]])
    )
print(f"created {len(S.TABLE_ORDER)} empty raw tables")
