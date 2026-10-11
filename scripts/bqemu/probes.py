"""Run a slice of the planned probes' BigQuery SQL on the emulator and print one JSON line per probe."""

import json
import sys

from google.api_core.client_options import ClientOptions
from google.auth.credentials import AnonymousCredentials
from google.cloud import bigquery

from datatrust.dbt.build import relations_map
from datatrust.diagnostics.probes import ProbeRequest, render
from datatrust.warehouse.bigquery_wh import BigQueryWarehouse

client = bigquery.Client(
    project="datatrust-emu",
    credentials=AnonymousCredentials(),
    client_options=ClientOptions(api_endpoint=sys.argv[1]),
)
rel = relations_map(json.load(open("/tmp/emu/target/manifest.json")))
lo, hi = (int(x) for x in sys.argv[2].split(":"))
wh = BigQueryWarehouse("datatrust-emu", "US", client=client)
wh.relation_columns = lambda node: set(node.get("columns") or {})  # the emulator has no INFORMATION_SCHEMA
for p in json.load(open("/tmp/plan.json"))[lo:hi]:
    req = ProbeRequest.from_json(p)
    try:
        for sql in render(req, rel, "bigquery", wh.relation_columns).values():
            wh.query(sql, max_rows=1)
        print(json.dumps({"probe": req.probe_id, "ok": True}), flush=True)
    except Exception as err:  # noqa: BLE001
        print(
            json.dumps(
                {"probe": req.probe_id, "ok": False, "error": f"{type(err).__name__}: {str(err)[:300]}"}
            ),
            flush=True,
        )
