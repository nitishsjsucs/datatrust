#!/usr/bin/env bash
# Idempotent production bootstrap (SPEC 18.1): creates every Cloudflare and Google Cloud resource DataTrust
# needs, from the CLIs, once Nitish is logged in. Every step checks for the resource first and creates only
# what is missing, recording ids in .prod/state.json, so a rerun after a partial failure continues.
# Cloudflare: Workers Free plan only (SPEC 28): D1, two R2 buckets, Basin Catalog, five datatrust-* queues,
# the AI Gateway, migrations and the Worker. No Workers Paid feature. Google Cloud: only datatrust_* datasets
# and datatrust-* identities in the shared project, with dataset- or resource-scoped grants.
#
#   npm run setup:prod                       Cloudflare, then Google Cloud
#   npm run setup:prod -- --cloudflare-only
#   npm run setup:prod -- --gcp-only
#   npm run setup:prod -- --dry-run          print the plan; change nothing
#   npm run setup:prod -- --use-env-token    let wrangler use CLOUDFLARE_API_TOKEN instead of `wrangler login`
#
# Values come from .env.prod (cp .env.example .env.prod && chmod 600 .env.prod). See README, production setup.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
PROD="$ROOT/.prod"
STATE="$PROD/state.json"
ENV_FILE="${DATATRUST_ENV_FILE:-$ROOT/.env.prod}"
DO_CF=1 DO_GCP=1 DRY=0 USE_ENV_TOKEN=0
for arg in "$@"; do
  case "$arg" in
    --cloudflare-only) DO_GCP=0 ;;
    --gcp-only) DO_CF=0 ;;
    --dry-run) DRY=1 ;;
    --use-env-token) USE_ENV_TOKEN=1 ;;
    *) echo "unknown option $arg" >&2; exit 2 ;;
  esac
done
mkdir -p "$PROD"
chmod 700 "$PROD"
[[ -f "$STATE" ]] || echo '{}' >"$STATE"

say() { printf '\n== %s\n' "$*"; }
note() { printf '   %s\n' "$*"; }
die() { printf '\nSTOP: %s\n' "$*" >&2; exit 1; }
run() { # mutating command: printed in --dry-run, executed otherwise
  if ((DRY)); then printf '   [dry-run] %s\n' "$*"; else "$@"; fi
}
state_get() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2], ""))' "$STATE" "$1"; }
state_set() {
  ((DRY)) && return 0
  python3 -c 'import json,sys; p=sys.argv[1]; d=json.load(open(p)); d[sys.argv[2]]=sys.argv[3]; json.dump(d, open(p,"w"), indent=1)' "$STATE" "$1" "$2"
}
env_set() { # KEY VALUE: set or replace a line in .env.prod
  ((DRY)) && return 0
  python3 - "$ENV_FILE" "$1" "$2" <<'PY'
import re, sys
path, key, value = sys.argv[1:]
text = open(path).read() if __import__("os").path.exists(path) else ""
line = f"{key}={value}"
if re.search(rf"^{re.escape(key)}=.*$", text, flags=re.M):
    text = re.sub(rf"^{re.escape(key)}=.*$", line, text, flags=re.M)
else:
    text += ("" if text.endswith("\n") or not text else "\n") + line + "\n"
open(path, "w").write(text)
PY
  chmod 600 "$ENV_FILE"
}
# Find an object by name in wrangler JSON output and print one of its id fields (field names vary by command).
json_id() { # name [json on stdin]
  python3 -c '
import json, sys
name = sys.argv[1]
raw = sys.stdin.read()
start = min([i for i in (raw.find("["), raw.find("{")) if i >= 0], default=-1)
data = json.loads(raw[start:]) if start >= 0 else []
def walk(x):
    if isinstance(x, dict):
        if x.get("name") == name:
            for k in ("uuid", "id", "database_id"):
                if x.get(k):
                    print(x[k]); sys.exit(0)
        for v in x.values():
            walk(v)
    elif isinstance(x, list):
        for v in x:
            walk(v)
walk(data)
' "$1"
}

# ---------------------------------------------------------------------------------------------- preflight
say "Preflight"
[[ -f "$ENV_FILE" ]] || die ".env.prod not found: cp .env.example .env.prod && chmod 600 .env.prod, then fill it in (README)"
if grep -qE '^CLOUDFLARE_API_TOKEN=.+' "$ENV_FILE"; then
  die ".env.prod defines CLOUDFLARE_API_TOKEN, which overrides \`wrangler login\` for every wrangler call. Rename it to DATATRUST_CF_API_TOKEN (it is only used for the AI Gateway API)."
fi
set -a
# Values are shell-quoted by Python, so eval only ever sees KEY='value' assignments.
eval "$(python3 - "$ENV_FILE" <<'PY'
import shlex, sys
for line in open(sys.argv[1]):
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    k, v = line.split("=", 1)
    k, v = k.strip(), v.strip().strip("'\"")
    if v and k.replace("_", "").isalnum():
        print(f"{k}={shlex.quote(v)}")
PY
)"
set +a
if ((USE_ENV_TOKEN)); then
  wr() { (cd "$ROOT/apps/worker" && npx wrangler "$@"); }
  note "wrangler will use CLOUDFLARE_API_TOKEN from the environment (--use-env-token)"
else
  # Always use the OAuth session from `wrangler login`, even if the shell exports a token (wrangler prefers env credentials).
  wr() { (cd "$ROOT/apps/worker" && env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_API_KEY -u CLOUDFLARE_EMAIL npx wrangler "$@"); }
fi
export WRANGLER_SEND_METRICS=false

# ---------------------------------------------------------------------------------------------- Cloudflare
if ((DO_CF)); then
  say "Cloudflare: account"
  WHO="$(wr whoami 2>&1 || true)"
  if grep -qiE "not authenticated|not logged in" <<<"$WHO" || ! grep -qi "account" <<<"$WHO"; then
    die "wrangler is not logged in: cd apps/worker && npx wrangler login"
  fi
  [[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]] || die "set CLOUDFLARE_ACCOUNT_ID in .env.prod (shown by \`npx wrangler whoami\`)"
  note "logged in; account ${CLOUDFLARE_ACCOUNT_ID}"

  say "1. D1 database datatrust"
  D1_ID="$(wr d1 list --json 2>/dev/null | json_id datatrust || true)"
  if [[ -z "$D1_ID" ]]; then
    # --update-config=false: otherwise wrangler offers (default yes) to write the new id into the committed
    # local apps/worker/wrangler.jsonc; the production id belongs only in the rendered wrangler.prod.jsonc.
    run wr d1 create datatrust --update-config=false
    D1_ID="$(wr d1 info datatrust --json 2>/dev/null | python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); print(d.get("uuid") or d.get("id") or "")' || true)"
  fi
  [[ -n "$D1_ID" || $DRY -eq 1 ]] || die "could not read the D1 database id; run \`npx wrangler d1 info datatrust\` and set it in .prod/state.json as d1_id"
  state_set d1_id "${D1_ID:-dry-run}"
  note "d1 id ${D1_ID:-<created on a real run>}"

  say "2. R2 buckets"
  for b in datatrust-artifacts datatrust-lake; do
    if wr r2 bucket info "$b" --json >/dev/null 2>&1; then note "$b exists"; else run wr r2 bucket create "$b" --update-config=false; fi
  done

  say "3. Basin Catalog on datatrust-lake"
  # `wrangler basin catalog get` has no --json. When enabled it prints "Catalog URI:", "Warehouse:" and
  # "Status:" lines; when not, a sentence containing "is not enabled" (wrangler 4.149 source), so the check
  # looks for the Warehouse line, never for the word "enabled".
  CATALOG_PARSER="$(cat <<'PYCAT'
import re, sys
text = re.sub(r"\x1b\[[0-9;]*m", "", sys.stdin.read())
if "not enabled" in text:
    sys.exit(0)
wh = re.search(r"^\s*Warehouse:\s*(\S+)\s*$", text, re.M)
uri = re.search(r"^\s*Catalog URI:\s*(https://\S+)\s*$", text, re.M)
if wh and uri:
    print(wh.group(1), uri.group(1))
PYCAT
)"
  CATALOG="$(wr basin catalog get datatrust-lake 2>&1 || true)"
  INFO="$(printf '%s\n' "$CATALOG" | python3 -c "$CATALOG_PARSER")"
  if [[ -z "$INFO" ]]; then
    run wr basin catalog enable datatrust-lake
    CATALOG="$(wr basin catalog get datatrust-lake 2>&1 || true)"
    INFO="$(printf '%s\n' "$CATALOG" | python3 -c "$CATALOG_PARSER")"
  else
    note "catalog already enabled"
  fi
  if [[ -n "$INFO" ]]; then
    WAREHOUSE="${INFO%% *}"
    CATALOG_URI="${INFO#* }"
    env_set BASIN_WAREHOUSE "$WAREHOUSE"
    env_set BASIN_CATALOG_URI "$CATALOG_URI"
    export BASIN_WAREHOUSE="$WAREHOUSE" BASIN_CATALOG_URI="$CATALOG_URI"
    note "warehouse $WAREHOUSE, catalog $CATALOG_URI"
  elif [[ -z "${BASIN_WAREHOUSE:-}" || -z "${BASIN_CATALOG_URI:-}" ]]; then
    note "could not parse the catalog details from:"
    printf '%s\n' "$CATALOG" | sed 's/^/     /'
    ((DRY)) || die "copy the Warehouse and Catalog URI shown above into .env.prod as BASIN_WAREHOUSE and BASIN_CATALOG_URI, then rerun"
  fi

  say "4. Queues"
  for q in datatrust-check-results datatrust-lineage-events datatrust-investigate datatrust-audit-events datatrust-dlq; do
    if wr queues info "$q" >/dev/null 2>&1; then note "$q exists"; else run wr queues create "$q"; fi
  done

  # Steps 5 to 7 (Basin Pipelines stream, sink and pipeline) were removed in spec 1.2: Basin Pipelines is
  # Workers Paid only, and production runs on the Workers Free plan (SPEC 28, ADR-0008). The audit lake needs
  # only the queue of step 4 and the catalog of step 3; `datatrust lake commit --catalog basin` writes it.
  if [[ -z "${BASIN_CATALOG_TOKEN:-}" ]]; then
    note "BASIN_CATALOG_TOKEN is not in .env.prod yet: the lake commit and the smoke need it (token datatrust-lake-committer scoped to the datatrust-lake bucket: docs/basin-catalog-token.md, README Cloudflare step 9)"
  fi

  say "8. AI Gateway datatrust"
  if [[ -n "${DATATRUST_CF_API_TOKEN:-}" ]]; then
    API="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai-gateway/gateways"
    CODE="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${DATATRUST_CF_API_TOKEN}" "$API/datatrust")"
    if [[ "$CODE" == "200" ]]; then
      note "gateway exists"
    elif [[ "$CODE" == "404" ]]; then
      run curl -fsS -X POST "$API" -H "Authorization: Bearer ${DATATRUST_CF_API_TOKEN}" -H 'content-type: application/json' \
        -d '{"id":"datatrust","cache_invalidate_on_update":false,"cache_ttl":0,"collect_logs":true,"rate_limiting_interval":60,"rate_limiting_limit":60,"rate_limiting_technique":"fixed"}'
    else
      note "AI Gateway API answered HTTP $CODE; check DATATRUST_CF_API_TOKEN (AI Gateway Read and Edit)"
    fi
  else
    note "DATATRUST_CF_API_TOKEN not set: create the gateway in the dashboard (AI, AI Gateway, Create Gateway, name datatrust); doctor reports it"
  fi

  say "9. Render wrangler.prod.jsonc and apply D1 migrations"
  TEAM_ARGS=()
  [[ -n "${ACCESS_TEAM_DOMAIN:-}" ]] && TEAM_ARGS=(--team "$ACCESS_TEAM_DOMAIN")
  if ((DRY)); then
    note "[dry-run] node scripts/render-prod-config.mjs --d1 <d1 id> ${TEAM_ARGS[*]-}"
  else
    node scripts/render-prod-config.mjs --d1 "$(state_get d1_id)" ${TEAM_ARGS[@]+"${TEAM_ARGS[@]}"}
  fi
  run wr d1 migrations apply datatrust --remote -c "$ROOT/apps/worker/wrangler.prod.jsonc"

  say "10. Worker secrets (.prod/secrets.json) and the runner's evidence key"
  if [[ -z "${EVIDENCE_HMAC_KEY:-}" ]]; then
    # The runner's pseudonymization key: kept in .env.prod only, never deployed to the Worker.
    EVIDENCE_HMAC_KEY="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
    env_set EVIDENCE_HMAC_KEY "$EVIDENCE_HMAC_KEY"
    note "generated EVIDENCE_HMAC_KEY (saved to .env.prod for the runner; not a Worker secret)"
  fi
  # ROLE_MAP_JSON: your Access email -> operator+viewer; datatrust-runner -> runner; datatrust-operator ->
  # operator+viewer (pipelines/datatrust/prod/worker_secrets.py).
  run uv run --locked datatrust prod worker-secrets --out "$PROD/secrets.json"
  note "ACCESS_AUD=${ACCESS_AUD:-unset}"

  say "11. Deploy the Worker with its secrets"
  run npm run -s build # RCA bundle and the dashboard assets (apps/web/dist) the Worker serves
  if ((DRY)); then
    note "[dry-run] wrangler deploy -c apps/worker/wrangler.prod.jsonc --secrets-file .prod/secrets.json"
  else
    # Output stays on the terminal (not piped), so on a new account wrangler can ask to register the
    # workers.dev subdomain; the deployed URL is read from wrangler's structured output file instead.
    OUT_FILE="$PROD/wrangler-deploy.ndjson"
    rm -f "$OUT_FILE"
    WRANGLER_OUTPUT_FILE_PATH="$OUT_FILE" wr deploy -c "$ROOT/apps/worker/wrangler.prod.jsonc" \
      --secrets-file "$PROD/secrets.json"
    URL="$(python3 - "$OUT_FILE" <<'PY2'
import json, os, re, sys
url = ""
lines = open(sys.argv[1]).read().splitlines() if os.path.exists(sys.argv[1]) else []
for line in lines:
    entry = json.loads(line)
    if entry.get("type") == "deploy":
        for target in entry.get("targets") or []:
            m = re.search(r"https://[a-z0-9.-]+\.workers\.dev", str(target))
            if m:
                url = m.group(0)
print(url)
PY2
)"
    if [[ -n "$URL" ]]; then
      state_set worker_url "$URL"
      env_set DATATRUST_API_URL "$URL"
      note "Worker URL $URL (saved to .env.prod as DATATRUST_API_URL)"
    else
      note "could not read the workers.dev URL from $OUT_FILE; set DATATRUST_API_URL in .env.prod by hand"
    fi
  fi

  if [[ -z "${ACCESS_AUD:-}" || "${ACCESS_AUD}" == "unset" || -z "${CF_ACCESS_CLIENT_ID:-}" || -z "${CF_ACCESS_OPERATOR_CLIENT_ID:-}" ]]; then
    say "12. Cloudflare Access is not fully configured yet"
    note "The Worker is deployed fail-closed: every API call answers 401 until ACCESS_AUD is set."
    note "Worker URL: $(state_get worker_url)"
    note "Next (README, production setup, Cloudflare steps 12-15):"
    note "  - Workers & Pages > datatrust > Settings > Domains & Routes: Enable Cloudflare Access on the workers.dev route, allow your email"
    note "  - copy the Application Audience (AUD) tag into ACCESS_AUD and https://<team>.cloudflareaccess.com into ACCESS_TEAM_DOMAIN"
    note "  - create service tokens datatrust-runner and datatrust-operator; save CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET"
    note "    (runner) and CF_ACCESS_OPERATOR_CLIENT_ID / CF_ACCESS_OPERATOR_CLIENT_SECRET (operator); add one Service Auth"
    note "    policy on the datatrust Access app that includes both tokens"
    note "  - rerun: npm run setup:prod -- --cloudflare-only"
    note "rerun after Access is configured"
    ((DO_GCP)) || exit 0
  fi
fi

# ---------------------------------------------------------------------------------------------- Google Cloud
if ((DO_GCP)); then
  say "13. Google Cloud preflight"
  command -v gcloud >/dev/null && command -v bq >/dev/null || die "install the Google Cloud CLI: brew install --cask gcloud-cli, then gcloud init"
  P="${DATATRUST_GCP_PROJECT:-}"
  LOC="${DATATRUST_BQ_LOCATION:-US}"
  [[ -n "$P" && "$P" != "datatrust-ci-placeholder" ]] || die "set DATATRUST_GCP_PROJECT in .env.prod"
  [[ "$(gcloud config get-value project 2>/dev/null)" == "$P" ]] || die "gcloud config set project $P"
  ADC="${GOOGLE_APPLICATION_CREDENTIALS:-$HOME/.config/gcloud/application_default_credentials.json}"
  [[ -f "$ADC" ]] || die "gcloud auth application-default login"
  [[ "$(gcloud billing projects describe "$P" --format='value(billingEnabled)' 2>/dev/null)" == "True" ]] || die "billing is not enabled on $P: enable it at https://console.cloud.google.com/billing?project=$P (README Google Cloud step 2)"
  USER_EMAIL="$(gcloud config get-value account 2>/dev/null)"
  note "project $P, location $LOC, account $USER_EMAIL"

  say "14. ADC quota project"
  run gcloud auth application-default set-quota-project "$P"

  say "15. APIs"
  run gcloud services enable bigquery.googleapis.com datacatalog.googleapis.com bigquerydatapolicy.googleapis.com \
    iam.googleapis.com iamcredentials.googleapis.com --project="$P"

  say "16. Datasets with a 7-day time-travel window"
  for D in datatrust_raw datatrust_staging datatrust_marts datatrust_restricted; do
    bq show --format=prettyjson "$P:$D" >/dev/null 2>&1 || run bq mk --dataset --location="$LOC" "$P:$D"
    run bq update --dataset=true --max_time_travel_hours=168 "$P:$D"
  done

  say "17. Service accounts"
  for SA in datatrust-analyst datatrust-prober; do
    EMAIL="$SA@$P.iam.gserviceaccount.com"
    gcloud iam service-accounts describe "$EMAIL" --project="$P" >/dev/null 2>&1 \
      || run gcloud iam service-accounts create "$SA" --project="$P" --display-name="DataTrust ${SA#datatrust-}"
    run gcloud iam service-accounts add-iam-policy-binding "$EMAIL" --project="$P" \
      --member="user:$USER_EMAIL" --role=roles/iam.serviceAccountTokenCreator --condition=None >/dev/null
    run gcloud projects add-iam-policy-binding "$P" --member="serviceAccount:$EMAIL" \
      --role=roles/bigquery.jobUser --condition=None >/dev/null
  done

  say "18. Governance: taxonomy, policy tags, masking (v1 data policies bound to the tags), IAM"
  # Fine-Grained Reader goes to the Google identity that runs dbt (the gcloud account), not to the
  # Cloudflare Access email in DATATRUST_OPERATOR_EMAIL, which may be a different address.
  export DATATRUST_GCP_USER="$USER_EMAIL"
  run uv run datatrust prod governance apply

  say "19. Validate the BigQuery path (compile, build --empty, probe dry runs)"
  run uv run datatrust prod validate

  say "20. Real dbt build on BigQuery"
  if ((DRY)); then
    note "[dry-run] DATATRUST_DBT_TARGET=bigquery dbt build --vars <.prod/dbt_vars.yml>"
  else
    DATATRUST_DBT_TARGET=bigquery DATATRUST_GCP_PROJECT="$P" DATATRUST_BQ_LOCATION="$LOC" \
      uv run dbt build --project-dir dbt --profiles-dir dbt --target-path "$PROD/dbt-target" \
      --vars "$(cat "$PROD/dbt_vars.yml")"
  fi

  say "21. Governance verification as datatrust-analyst (retries up to 10 minutes for IAM propagation)"
  run uv run datatrust prod governance verify
fi

say "Done. Check everything with: npm run doctor -- --prod"
