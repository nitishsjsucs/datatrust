#!/usr/bin/env bash
# Prerequisite check (SPEC 18.2): `npm run doctor` (local) or `npm run doctor -- --prod`.
# Checks the toolchain here, then the rest with `uv run datatrust doctor`.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
MODE=local
for arg in "$@"; do
  case "$arg" in
    --local) MODE=local ;;
    --prod) MODE=prod ;;
    *) echo "usage: npm run doctor [-- --local|--prod]" >&2; exit 2 ;;
  esac
done
missing=0
ok() { echo "[ok] $1"; }
miss() { echo "[missing] $1"; echo "         fix: $2"; missing=$((missing + 1)); }
echo "== Toolchain"
if command -v node >/dev/null; then
  major="$(node -p 'process.versions.node.split(".")[0]')"
  if ((major >= 22)); then ok "node $(node --version) (wrangler needs >= 22)"; else miss "node >= 22 (found $(node --version))" "install Node 24 LTS (see .nvmrc)"; fi
else
  miss "node" "install Node 24 LTS (see .nvmrc)"
fi
command -v npm >/dev/null && ok "npm $(npm --version)" || miss "npm" "comes with Node"
if command -v uv >/dev/null; then ok "$(uv --version)"; else miss "uv" "curl -LsSf https://astral.sh/uv/install.sh | sh"; fi
if ((missing > 0)); then
  echo "== $missing required item(s) missing"
  exit 1
fi
if [[ ! -d .venv ]]; then
  miss "uv sync done" "uv sync --locked"
  echo "== $missing required item(s) missing"
  exit 1
fi
exec uv run --locked datatrust doctor "--$MODE"
