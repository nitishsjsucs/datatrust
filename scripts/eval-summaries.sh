#!/usr/bin/env bash
# Summary faithfulness eval (SPEC 12.4, stretch) with the local LLM stand-in for Workers AI:
# starts llama-server (Qwen3-1.7B) on 127.0.0.1:8160, runs `datatrust bench summaries --provider local-llm`
# on the seed-101 incidents, and always stops llama-server again.
#   npm run eval:summaries                 local LLM
#   npm run eval:summaries -- --template   deterministic template only (no llama-server)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
if [[ "${1:-}" == "--template" ]]; then
  exec uv run datatrust bench summaries --provider template --workers 4
fi
MODEL="${DATATRUST_LLM_MODEL_PATH:-$HOME/Developer/projects/_models/Qwen3-1.7B-Q4_0-rtn.gguf}"
command -v llama-server >/dev/null || { echo "llama-server not on PATH (brew install llama.cpp)" >&2; exit 1; }
[[ -f "$MODEL" ]] || { echo "model not found: $MODEL (set DATATRUST_LLM_MODEL_PATH)" >&2; exit 1; }
if curl -fsS -o /dev/null http://127.0.0.1:8160/health 2>/dev/null; then
  echo "port 8160 is already serving; stop it first (npm run dev:down)" >&2
  exit 1
fi
mkdir -p .dev/logs
set -m
llama-server -m "$MODEL" --host 127.0.0.1 --port 8160 -np 1 -c 8192 -ngl 99 >.dev/logs/llama-eval.log 2>&1 &
PID=$!
cleanup() { kill -TERM "-$PID" 2>/dev/null || kill -TERM "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM
deadline=$((SECONDS + 180))
until curl -fsS -o /dev/null http://127.0.0.1:8160/health 2>/dev/null; do
  ((SECONDS < deadline)) || { echo "llama-server did not become healthy; see .dev/logs/llama-eval.log" >&2; exit 1; }
  sleep 1
done
uv run datatrust bench summaries --provider local-llm --workers 4 "$@"
