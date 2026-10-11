#!/usr/bin/env bash
# Stop everything dev-up started (process groups recorded in .dev/pids/) and confirm ports 8792, 9242 and
# 8160 are free. Exits non-zero if a port is still in use.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIDS="$ROOT/.dev/pids"
port_busy() { # lsof on macOS, ss on Linux runners
  if command -v lsof >/dev/null 2>&1; then lsof -iTCP:"$1" -sTCP:LISTEN -n -P >/dev/null 2>&1
  else ss -ltn "sport = :$1" | grep -q LISTEN; fi
}

stop() { # signal pidfile
  local pid
  pid="$(cat "$2" 2>/dev/null || true)"
  [[ -n "$pid" ]] || return 0
  kill "-$1" "-$pid" 2>/dev/null || kill "-$1" "$pid" 2>/dev/null || true
}

shopt -s nullglob
files=("$PIDS"/*.pid)
for f in "${files[@]}"; do stop TERM "$f"; done
for _ in $(seq 1 20); do
  busy=0
  for port in 8792 9242 8160; do port_busy "$port" && busy=1; done
  ((busy == 0)) && break
  sleep 0.5
done
if ((busy)); then
  for f in "${files[@]}"; do stop KILL "$f"; done
  sleep 1
fi
rm -f "${files[@]}"
status=0
for port in 8792 9242 8160; do
  if port_busy "$port"; then echo "port $port still in use" >&2; status=1; else echo "port $port free"; fi
done
exit $status
