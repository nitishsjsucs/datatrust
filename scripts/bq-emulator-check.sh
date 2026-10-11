#!/usr/bin/env bash
# Optional BigQuery SQL check against the goccy BigQuery emulator (ghcr.io/goccy/bigquery-emulator, ZetaSQL
# analyzer with SQLite execution). It is NOT BigQuery and proves nothing about BigQuery itself: it catches SQL
# that BigQuery's analyzer would reject (types, functions, contract column types) before `prod validate`.
#   bash scripts/bq-emulator-check.sh        (needs Docker; uses a private Docker network, no host ports)
# Steps: empty raw tables; each of the 29 models in dependency order (enforced contracts included); each of
# the 40 tests on its own. The emulator restarts (file-backed) before each step because it needs a lot of
# memory per query; a step during which it stops is reported as "no result", never as a pass. Probe SQL is not
# run here (the emulator stops too often on it in a 2 GB VM); `test_probes_render.py` parses it and
# `prod validate` dry-runs it on BigQuery. Writes results/bq-emulator-<date>.md and .json.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
EMU_IMAGE=ghcr.io/goccy/bigquery-emulator:0.8.1
NET=datatrust-bqemu-net VOL=datatrust-bqemu-data EMU=datatrust-bqemu RUN=datatrust-bqemu-run IMG=datatrust-bqemu-runner
WORK="$(mktemp -d)"
cleanup() {
  docker rm -f "$RUN" "$EMU" >/dev/null 2>&1
  docker volume rm "$VOL" >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM
command -v docker >/dev/null && docker info >/dev/null 2>&1 || { echo "Docker is not running" >&2; exit 1; }

emu() {
  docker rm -f "$EMU" >/dev/null 2>&1
  docker run -d --name "$EMU" --network "$NET" --memory 1200m -v "$VOL:/data" "$EMU_IMAGE" \
    --project=datatrust-emu --dataset=datatrust_raw --database=/data/bq.db --log-level=warn >/dev/null
  sleep 3
}
dbtx() { # dbt in the runner container; stops early when the emulator container has stopped
  docker exec "$RUN" timeout 180 bash -c \
    "cd /work && uv run dbt $* --project-dir dbt --profiles-dir /tmp/emu --target-path /tmp/emu/target --log-path /tmp/emu/logs" &
  local pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if ! docker ps --format '{{.Names}}' | grep -qx "$EMU"; then
      docker exec "$RUN" pkill -f "bin/dbt" >/dev/null 2>&1
      break
    fi
    sleep 2
  done
  wait "$pid"
}

docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null
docker volume rm "$VOL" >/dev/null 2>&1; docker volume create "$VOL" >/dev/null
docker build -q -t "$IMG" scripts/bqemu >/dev/null
docker rm -f "$RUN" >/dev/null 2>&1
docker run -d --name "$RUN" --network "$NET" --memory 700m "$IMG" sleep 10800 >/dev/null
emu
# The commit the containers build from, recorded in the report (later commits during the run do not count).
COMMIT="$(git rev-parse --short HEAD)"
git archive "$COMMIT" | docker exec -i "$RUN" bash /bqemu/setup.sh

# One model at a time, in dependency order (the emulator restarts before each).
ORDER="$(docker exec "$RUN" bash -c "cd /work && uv run dbt ls --resource-type model --output json --output-keys 'name depends_on' -q --project-dir dbt --profiles-dir /tmp/emu --target-path /tmp/emu/ls --log-path /tmp/emu/logs" | python3 -c '
import json, sys
nodes = {}
for line in sys.stdin:
    if line.startswith("{"):
        d = json.loads(line)
        nodes["model.datatrust." + d["name"]] = [x for x in d["depends_on"]["nodes"] if x.startswith("model.")]
done, order = set(), []
def visit(n):
    if n in done: return
    done.add(n)
    for m in nodes.get(n, []): visit(m)
    order.append(n.split(".")[-1])
for n in sorted(nodes): visit(n)
print(" ".join(order))')"
MODELS=0
: >"$WORK/models.txt"
for m in $ORDER; do
  emu
  dbtx run --select "$m" >"$WORK/run.log" 2>&1
  if grep -qE 'Done. PASS=1 ' "$WORK/run.log"; then r=built; MODELS=$((MODELS + 1))
  elif grep -qE 'Done. .*ERROR=1' "$WORK/run.log"; then r="error: $(grep -m1 -E 'Database Error|Compilation Error|Runtime Error|contract' -A3 "$WORK/run.log" | tr -s ' \n' ' ' | cut -c1-300)"
  else r="no result (the emulator stopped)"; fi
  echo "$m: $r" | tee -a "$WORK/models.txt"
done

TESTS="$(docker exec "$RUN" bash -c "cd /work && uv run dbt ls --resource-type test --output name -q --project-dir dbt --profiles-dir /tmp/emu --target-path /tmp/emu/ls --log-path /tmp/emu/logs" | grep '^dq_' || true)"
: >"$WORK/tests.txt"
for t in $TESTS; do
  emu
  dbtx test --select "$t" >"$WORK/test.log" 2>&1
  if grep -qE 'Done. PASS=1 ' "$WORK/test.log"; then r=pass
  elif grep -qE 'Done. .*ERROR=1' "$WORK/test.log"; then r="error: $(grep -m1 -E 'Database Error|Compilation Error|Runtime Error' -A2 "$WORK/test.log" | tr -s ' \n' ' ' | cut -c1-240)"
  elif grep -qE 'Done. .*FAIL=1' "$WORK/test.log"; then r=fail
  else r="no result (the emulator stopped)"; fi
  echo "$t: $r" | tee -a "$WORK/tests.txt"
done

uv run python - "$WORK" "$MODELS" "$EMU_IMAGE" "$COMMIT" <<'PY'
import datetime as dt, json, sys
from pathlib import Path
work, models, image, commit = Path(sys.argv[1]), int(sys.argv[2]), sys.argv[3], sys.argv[4]
model_rows = [l.split(": ", 1) for l in (work / "models.txt").read_text().splitlines() if ": " in l]
tests = [l.split(": ", 1) for l in (work / "tests.txt").read_text().splitlines() if ": " in l]
date = dt.date.today().isoformat()
out = {
    "date": date, "commit": commit, "command": "bash scripts/bq-emulator-check.sh", "emulator": image,
    "note": "goccy BigQuery emulator (ZetaSQL analyzer, SQLite execution) on empty raw tables; not BigQuery",
    "models_built": models, "models_total": 29, "models": {m: r for m, r in model_rows},
    "tests": {t: r for t, r in tests},
}
counts = {k: sum(1 for _, r in tests if r.startswith(k)) for k in ("pass", "fail", "error", "no result")}
out["test_counts"] = counts
Path("results").mkdir(exist_ok=True)
Path(f"results/bq-emulator-{date}.json").write_text(json.dumps(out, indent=1) + "\n")
lines = [
    f"# BigQuery SQL on the goccy emulator, {date}", "",
    f"Command `bash scripts/bq-emulator-check.sh` at commit `{commit}`, emulator `{image}`.",
    "The emulator analyzes SQL with ZetaSQL and executes it on SQLite. It is not BigQuery: this checks that",
    "the BigQuery SQL is accepted and type-checks, on empty raw tables. Real validation is `npm run prod:validate`.", "",
    f"- Models built with enforced contracts: {models}/29",
    f"- Tests: {counts['pass']} pass, {counts['fail']} fail, {counts['error']} error, {counts['no result']} without a result (emulator stopped)",
    "",
    "| Model | Result |", "|---|---|", *[f"| {m} | {r} |" for m, r in model_rows], "",
    "| Test | Result |", "|---|---|", *[f"| {t} | {r} |" for t, r in tests],
]
Path(f"results/bq-emulator-{date}.md").write_text("\n".join(lines) + "\n")
print("\n".join(lines[6:8]))
PY
