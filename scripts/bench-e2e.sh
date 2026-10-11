#!/usr/bin/env bash
# End-to-end benchmark (SPEC 12.2, 20): start the local Worker, run trials through Queues and both
# Workflows with the runner, compare with the offline mode, and always stop what was started.
#   npm run bench:e2e                      full seed-101 e2e benchmark (20 scenarios) with the parity check
#   npm run bench:e2e -- --pytest          the CI subset: S01, T14, S04 plus the parity test
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cleanup() { bash "$ROOT/scripts/dev-down.sh" || true; }
trap cleanup EXIT INT TERM
cd "$ROOT"
[[ -f packages/rca/dist/cli.mjs ]] || npm run -s build -w @datatrust/rca
bash scripts/dev-up.sh
export DATATRUST_API_URL="http://127.0.0.1:8792"
if [[ "${1:-}" == "--pytest" ]]; then
  uv run pytest -m e2e
else
  uv run datatrust bench --mode e2e --seeds 101 --parity --workers 4 "$@"
fi
