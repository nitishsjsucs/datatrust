#!/usr/bin/env bash
# Inside the runner container: unpack the repository from stdin, install, write the emulator profile, create
# the four datasets and the 13 raw tables (empty: the check is about BigQuery SQL validity, not data).
set -euo pipefail
cd /work && tar -xf -
uv sync --locked >/dev/null 2>&1
cp /bqemu/emu_patch.py .venv/lib/python3.12/site-packages/emu_patch.py
echo "import emu_patch" > .venv/lib/python3.12/site-packages/emu_patch.pth
mkdir -p /tmp/emu
cat > /tmp/emu/profiles.yml <<'YML'
datatrust:
  target: emu
  outputs:
    emu:
      type: bigquery
      method: oauth-secrets
      token: emulator-not-bigquery
      project: datatrust-emu
      dataset: datatrust_staging
      location: US
      threads: 1
      job_execution_timeout_seconds: 600
      api_endpoint: http://dt-bqemu:9050
YML
uv run python /bqemu/load.py http://dt-bqemu:9050
