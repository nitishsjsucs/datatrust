#!/usr/bin/env bash
# Start the local stack (SPEC 16): wrangler dev --local on 127.0.0.1:8792 (inspector 9242), and with --llm
# also llama-server (Qwen3-1.7B) on 127.0.0.1:8160, with the Worker's SUMMARIZER switched to the local
# OpenAI-compatible stand-in. PIDs (process groups) go to .dev/pids/; logs to .dev/logs/.
# Stop everything with `npm run dev:down`.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIDS="$ROOT/.dev/pids"
LOGS="$ROOT/.dev/logs"
mkdir -p "$PIDS" "$LOGS"
WITH_LLM=0
for arg in "$@"; do
  case "$arg" in
    --llm) WITH_LLM=1 ;;
    *) echo "unknown option $arg" >&2; exit 2 ;;
  esac
done
MODEL="${DATATRUST_LLM_MODEL_PATH:-$HOME/Developer/projects/_models/Qwen3-1.7B-Q4_0-rtn.gguf}"

port_busy() { # lsof on macOS, ss on Linux runners
  if command -v lsof >/dev/null 2>&1; then lsof -iTCP:"$1" -sTCP:LISTEN -n -P >/dev/null 2>&1
  else ss -ltn "sport = :$1" | grep -q LISTEN; fi
}
wait_http() { # url seconds [file for the first successful body]
  local url="$1" deadline=$((SECONDS + $2)) out="${3:-/dev/null}"
  until curl -fsS -o "$out" "$url" 2>/dev/null; do
    if ((SECONDS > deadline)); then return 1; fi
    sleep 1
  done
}

for port in 8792 9242; do
  if port_busy "$port"; then echo "port $port is already in use; run \`npm run dev:down\` first" >&2; exit 1; fi
done
[[ -f "$ROOT/apps/worker/.dev.vars" ]] || node "$ROOT/scripts/dev-keys.mjs"
[[ -f "$ROOT/apps/web/dist/index.html" ]] || (cd "$ROOT" && npm run -s build -w @datatrust/web >"$LOGS/web-build.log" 2>&1)
(cd "$ROOT/apps/worker" && npx wrangler d1 migrations apply datatrust --local >"$LOGS/migrations.log" 2>&1)

EXTRA_VARS=()
if ((WITH_LLM)); then EXTRA_VARS=(--var "SUMMARIZER:openai-compatible-local"); fi

set -m # background jobs get their own process group, so dev-down can stop wrangler and workerd together
(
  cd "$ROOT/apps/worker"
  exec npx wrangler dev --local --ip 127.0.0.1 --port 8792 --inspector-port 9242 \
    --show-interactive-dev-session=false ${EXTRA_VARS[@]+"${EXTRA_VARS[@]}"}
) >"$LOGS/wrangler.log" 2>&1 &
echo $! >"$PIDS/wrangler.pid"
# The first successful /healthz is the Worker's first request: its `warm` field says whether the start-up
# warm-up (apps/worker/src/warmup.ts) had settled before it (SPEC risk 23; scripts/bench-e2e.sh asserts it).
rm -f "$LOGS/first-healthz.json"
if ! wait_http http://127.0.0.1:8792/healthz 90 "$LOGS/first-healthz.json"; then
  echo "wrangler dev did not become healthy; see $LOGS/wrangler.log" >&2
  exit 1
fi
echo "worker ready on http://127.0.0.1:8792 (pid $(cat "$PIDS/wrangler.pid"))"

if ((WITH_LLM)); then
  if port_busy 8160; then echo "port 8160 is already in use" >&2; exit 1; fi
  if ! command -v llama-server >/dev/null; then echo "llama-server not on PATH" >&2; exit 1; fi
  if [[ ! -f "$MODEL" ]]; then echo "model not found: $MODEL" >&2; exit 1; fi
  llama-server -m "$MODEL" --host 127.0.0.1 --port 8160 -np 1 -c 8192 -ngl 99 >"$LOGS/llama.log" 2>&1 &
  echo $! >"$PIDS/llama.pid"
  if ! wait_http http://127.0.0.1:8160/health 180; then
    echo "llama-server did not become healthy; see $LOGS/llama.log" >&2
    exit 1
  fi
  echo "llama-server ready on http://127.0.0.1:8160 (pid $(cat "$PIDS/llama.pid"))"
fi
