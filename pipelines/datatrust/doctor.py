"""`npm run doctor [-- --local|--prod]` (SPEC 18.2): one line per prerequisite, `[ok]`, `[missing]` or `[warn]`,
with the exact command that fixes it. Exits non-zero when anything required for the chosen mode is missing.
`scripts/doctor.sh` checks the toolchain first, then runs this module.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import socket
import subprocess
import sys
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from datatrust import config

ROOT = config.REPO_ROOT
WORKER = ROOT / "apps" / "worker"
STATE = ROOT / ".prod" / "state.json"
QUEUES = (
    "datatrust-check-results",
    "datatrust-lineage-events",
    "datatrust-investigate",
    "datatrust-audit-events",
    "datatrust-dlq",
)
BUCKETS = ("datatrust-artifacts", "datatrust-lake")
GCP_APIS = (
    "bigquery.googleapis.com",
    "datacatalog.googleapis.com",
    "bigquerydatapolicy.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
)


@dataclass
class Check:
    status: str  # ok | missing | warn
    name: str
    detail: str = ""
    fix: str = ""
    required: bool = True

    def line(self) -> str:
        text = f"[{self.status}] {self.name}"
        if self.detail:
            text += f": {self.detail}"
        if self.fix and self.status != "ok":
            text += f"\n         fix: {self.fix}"
        return text


def run(cmd: list[str], *, timeout: float = 60, env: dict[str, str] | None = None, cwd: Path = ROOT):
    try:
        return subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout, cwd=cwd, env={**os.environ, **(env or {})}
        )
    except (OSError, subprocess.TimeoutExpired) as err:
        return subprocess.CompletedProcess(cmd, 127, "", str(err))


def wrangler(*args: str, timeout: float = 90):
    """wrangler with Cloudflare credentials from the environment removed, exactly like setup-prod's wr()."""
    env = {
        k: v
        for k, v in os.environ.items()
        if k not in ("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY", "CLOUDFLARE_EMAIL")
    }
    env["WRANGLER_SEND_METRICS"] = "false"
    try:
        return subprocess.run(
            ["npx", "--no-install", "wrangler", *args],
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=WORKER,
            env=env,
        )
    except (OSError, subprocess.TimeoutExpired) as err:
        return subprocess.CompletedProcess(args, 127, "", str(err))


def json_out(proc) -> Any:
    text = proc.stdout.strip()
    start = min([i for i in (text.find("["), text.find("{")) if i >= 0], default=-1)
    if start < 0:
        return None
    try:
        return json.loads(text[start:])
    except json.JSONDecodeError:
        return None


def names_in(data: Any) -> set[str]:
    out: set[str] = set()
    if isinstance(data, dict):
        for key in ("result", "results", "items", "streams", "sinks", "pipelines", "buckets"):
            if key in data:
                return names_in(data[key])
        name = data.get("name") or data.get("queue_name")
        if isinstance(name, str):
            out.add(name)
    elif isinstance(data, list):
        for item in data:
            out |= names_in(item)
    return out


def catalog_enabled(returncode: int, text: str) -> bool:
    """`wrangler basin catalog get` prints a "Warehouse:" line when the catalog is enabled, and a sentence
    containing "is not enabled" otherwise (exit code 0 in both cases)."""
    text = re.sub(r"\x1b\[[0-9;]*m", "", text)
    return (
        returncode == 0 and "not enabled" not in text and re.search(r"^\s*Warehouse:", text, re.M) is not None
    )


def port_free(port: int) -> bool:
    with socket.socket() as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", port)) != 0


def state() -> dict[str, Any]:
    return json.loads(STATE.read_text()) if STATE.exists() else {}


# ------------------------------------------------------------------------------------------------ local


def local_checks() -> list[Check]:
    out: list[Check] = []
    out.append(
        Check("ok", "npm ci done", "node_modules/wrangler present")
        if (ROOT / "node_modules" / "wrangler").exists()
        else Check("missing", "npm ci done", "node_modules/wrangler not found", "npm ci")
    )
    out.append(Check("ok", "uv sync done", f"python {sys.version.split()[0]}"))
    out.append(
        Check("ok", "RCA CLI bundle", "packages/rca/dist/cli.mjs")
        if (ROOT / "packages" / "rca" / "dist" / "cli.mjs").exists()
        else Check(
            "missing",
            "RCA CLI bundle",
            "packages/rca/dist/cli.mjs not built",
            "npm run build -w @datatrust/rca",
        )
    )
    keys = (ROOT / ".dev" / "keys" / "private.jwk.json").exists() and (WORKER / ".dev.vars").exists()
    out.append(
        Check("ok", "local Access keys", ".dev/keys and apps/worker/.dev.vars")
        if keys
        else Check("missing", "local Access keys", "no local RS256 keys", "npm run dev:keys")
    )
    pids = (
        {p.read_text().strip() for p in (ROOT / ".dev" / "pids").glob("*.pid")}
        if (ROOT / ".dev" / "pids").exists()
        else set()
    )
    for port in (8792, 9242, 8160):
        if port_free(port):
            out.append(Check("ok", f"port {port}", "free"))
        elif pids:
            out.append(Check("ok", f"port {port}", "in use by the dev stack (.dev/pids)"))
        else:
            out.append(
                Check(
                    "missing", f"port {port}", "in use by another process", f"lsof -iTCP:{port} -sTCP:LISTEN"
                )
            )
    model = Path(
        os.environ.get(
            "DATATRUST_LLM_MODEL_PATH", Path.home() / "Developer/projects/_models/Qwen3-1.7B-Q4_0-rtn.gguf"
        )
    )
    llama = shutil.which("llama-server")
    out.append(
        Check("ok", "llama-server and model (optional)", f"{llama}, {model.name}", required=False)
        if llama and model.exists()
        else Check(
            "warn",
            "llama-server and model (optional, only for `npm run dev:up -- --llm`)",
            "not found",
            "brew install llama.cpp; set DATATRUST_LLM_MODEL_PATH to a Qwen3-1.7B GGUF",
            required=False,
        )
    )
    try:
        import duckdb

        con = duckdb.connect()
        hour = con.execute(
            "select extract(hour from timezone('Asia/Kolkata', TIMESTAMPTZ '2025-06-30 03:00:00+00:00'))"
        ).fetchone()
        out.append(
            Check("ok", "DuckDB ICU time zones", f"duckdb {duckdb.__version__}")
            if hour and hour[0] == 8
            else Check("missing", "DuckDB ICU time zones", f"unexpected hour {hour}", "uv sync --locked")
        )
    except Exception as err:  # noqa: BLE001
        out.append(Check("missing", "DuckDB ICU time zones", str(err), "uv sync --locked"))
    profile = (ROOT / "dbt" / "profiles.yml").read_text()
    out.append(
        Check("ok", "dbt DuckDB session time zone", "TimeZone: UTC in dbt/profiles.yml")
        if re.search(r"TimeZone:\s*UTC", profile)
        else Check(
            "missing",
            "dbt DuckDB session time zone",
            "profile lacks TimeZone: UTC",
            "restore dbt/profiles.yml",
        )
    )
    return out


# ------------------------------------------------------------------------------------------------ .env.prod

ENV_KEYS: tuple[tuple[str, str], ...] = (
    ("CLOUDFLARE_ACCOUNT_ID", "shown by `npx wrangler whoami` (README Cloudflare step 6)"),
    ("DATATRUST_OPERATOR_EMAIL", "the email you log in to Access with (README Cloudflare step 9)"),
    ("BASIN_CATALOG_TOKEN", "R2 API token, Admin Read & Write (README Cloudflare step 8)"),
    ("ACCESS_TEAM_DOMAIN", "https://<team>.cloudflareaccess.com (README Cloudflare step 12)"),
    ("ACCESS_AUD", "Application Audience tag of the datatrust Access app (README Cloudflare step 12)"),
    ("CF_ACCESS_CLIENT_ID", "service token datatrust-runner (README Cloudflare step 13)"),
    ("CF_ACCESS_CLIENT_SECRET", "service token datatrust-runner (README Cloudflare step 13)"),
    ("CF_ACCESS_OPERATOR_CLIENT_ID", "service token datatrust-operator (README Cloudflare step 13)"),
    ("CF_ACCESS_OPERATOR_CLIENT_SECRET", "service token datatrust-operator (README Cloudflare step 13)"),
    ("DATATRUST_API_URL", "the deployed Worker URL; setup:prod writes it after the first deploy (step 10)"),
    ("DATATRUST_GCP_PROJECT", "your Google Cloud project id (README Google Cloud step 7)"),
)


def env_checks() -> list[Check]:
    from datatrust.prod.settings import ENV_PROD

    out: list[Check] = []
    if not ENV_PROD.exists():
        out.append(
            Check("missing", ".env.prod", "not found", "cp .env.example .env.prod && chmod 600 .env.prod")
        )
    else:
        mode = ENV_PROD.stat().st_mode & 0o777
        out.append(
            Check("ok", ".env.prod", f"mode {oct(mode)}")
            if mode & 0o077 == 0
            else Check(
                "warn", ".env.prod permissions", f"mode {oct(mode)}", "chmod 600 .env.prod", required=False
            )
        )
        if re.search(r"^CLOUDFLARE_API_TOKEN=.+", ENV_PROD.read_text(), flags=re.M):
            out.append(
                Check(
                    "missing",
                    ".env.prod has no CLOUDFLARE_API_TOKEN",
                    "it overrides `wrangler login`",
                    "rename it to DATATRUST_CF_API_TOKEN",
                )
            )
    for key, where in ENV_KEYS:
        value = os.environ.get(key, "")
        good = bool(value) and value != "unset" and value != "datatrust-ci-placeholder"
        out.append(
            Check("ok", f"{key}", "set")
            if good
            else Check("missing", f"{key}", "not set in .env.prod", where)
        )
    out.append(
        Check("ok", "DATATRUST_CF_API_TOKEN (optional)", "set", required=False)
        if os.environ.get("DATATRUST_CF_API_TOKEN")
        else Check(
            "warn",
            "DATATRUST_CF_API_TOKEN (optional)",
            "not set; create the AI Gateway in the dashboard instead",
            "README Cloudflare step 7",
            required=False,
        )
    )
    return out


# ------------------------------------------------------------------------------------------------ Cloudflare


def cloudflare_checks() -> list[Check]:
    out: list[Check] = []
    exported = [
        k for k in ("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY", "CLOUDFLARE_EMAIL") if os.environ.get(k)
    ]
    out.append(
        Check(
            "warn",
            "no Cloudflare credentials exported",
            f"{', '.join(exported)} set: wrangler uses it instead of `wrangler login` (setup-prod strips it)",
            f"unset {' '.join(exported)}",
            required=False,
        )
        if exported
        else Check("ok", "no Cloudflare credentials exported", required=False)
    )
    who = wrangler("whoami")
    logged_in = who.returncode == 0 and "not authenticated" not in (who.stdout + who.stderr).lower()
    out.append(
        Check("ok", "wrangler logged in")
        if logged_in
        else Check(
            "missing", "wrangler logged in", "not authenticated", "cd apps/worker && npx wrangler login"
        )
    )
    account = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    out.append(
        Check(
            "warn",
            "Workers Paid plan (manual check)",
            "wrangler cannot read the plan; Basin Pipelines needs Workers Paid",
            "dashboard: Workers & Pages, Plans (https://dash.cloudflare.com/?to=/:account/workers/plans)",
            required=False,
        )
    )
    if not logged_in:
        out.append(
            Check(
                "missing", "Cloudflare resources", "skipped until wrangler is logged in", "npx wrangler login"
            )
        )
        return out
    d1 = names_in(json_out(wrangler("d1", "list", "--json")))
    out.append(
        Check("ok", "D1 datatrust")
        if "datatrust" in d1
        else Check("missing", "D1 datatrust", "not found", "npm run setup:prod -- --cloudflare-only")
    )
    r2 = wrangler("r2", "bucket", "list")
    if r2.returncode != 0:
        out.append(
            Check(
                "missing",
                "R2 access",
                (r2.stderr or r2.stdout).strip()[-200:],
                "rerun `npx wrangler login`; if it still fails, create an account API token with Workers R2 Storage "
                "Edit and the catalog permissions and run setup with --use-env-token",
            )
        )
    else:
        for b in BUCKETS:
            out.append(
                Check("ok", f"R2 bucket {b}")
                if b in r2.stdout
                else Check(
                    "missing", f"R2 bucket {b}", "not found", "npm run setup:prod -- --cloudflare-only"
                )
            )
    cat = wrangler("basin", "catalog", "get", "datatrust-lake")
    out.append(
        Check("ok", "Basin Catalog on datatrust-lake")
        if catalog_enabled(cat.returncode, cat.stdout + cat.stderr)
        else Check(
            "missing",
            "Basin Catalog on datatrust-lake",
            "not enabled or not readable",
            "npm run setup:prod -- --cloudflare-only",
        )
    )
    queues = wrangler("queues", "list")
    for q in QUEUES:
        out.append(
            Check("ok", f"queue {q}")
            if q in queues.stdout
            else Check("missing", f"queue {q}", "not found", "npm run setup:prod -- --cloudflare-only")
        )
    for label, args, name in (
        (
            "Pipelines stream datatrust_events",
            ("basin", "pipelines", "streams", "list", "--json"),
            "datatrust_events",
        ),
        (
            "Pipelines sink datatrust_events_iceberg",
            ("basin", "pipelines", "sinks", "list", "--json"),
            "datatrust_events_iceberg",
        ),
        (
            "pipeline datatrust_events_pipeline",
            ("basin", "pipelines", "list", "--json"),
            "datatrust_events_pipeline",
        ),
    ):
        found = name in names_in(json_out(wrangler(*args)))
        out.append(
            Check("ok", label)
            if found
            else Check(
                "missing",
                label,
                "not found",
                "npm run setup:prod -- --cloudflare-only (needs BASIN_CATALOG_TOKEN)",
            )
        )
    token = os.environ.get("DATATRUST_CF_API_TOKEN")
    if token and account:
        try:
            import requests

            res = requests.get(
                f"https://api.cloudflare.com/client/v4/accounts/{account}/ai-gateway/gateways/datatrust",
                headers={"Authorization": f"Bearer {token}"},
                timeout=30,
            )
            out.append(
                Check("ok", "AI Gateway datatrust")
                if res.status_code == 200
                else Check(
                    "missing",
                    "AI Gateway datatrust",
                    f"HTTP {res.status_code}",
                    "npm run setup:prod -- --cloudflare-only",
                )
            )
        except Exception as err:  # noqa: BLE001
            out.append(Check("warn", "AI Gateway datatrust", str(err), required=False))
    else:
        out.append(
            Check(
                "warn",
                "AI Gateway datatrust",
                "cannot check without DATATRUST_CF_API_TOKEN",
                "create it in the dashboard (AI, AI Gateway, Create Gateway, name datatrust) or set DATATRUST_CF_API_TOKEN",
                required=False,
            )
        )
    rendered = WORKER / "wrangler.prod.jsonc"
    if rendered.exists() and "${" not in rendered.read_text():
        team_unset = "unset.cloudflareaccess.com" in rendered.read_text()
        out.append(
            Check(
                "warn",
                "wrangler.prod.jsonc rendered",
                "ACCESS_TEAM_DOMAIN is still the fail-closed placeholder",
                "set ACCESS_TEAM_DOMAIN in .env.prod and rerun setup",
                required=True,
            )
            if team_unset
            else Check("ok", "wrangler.prod.jsonc rendered")
        )
        secrets = wrangler("secret", "list", "-c", str(rendered))
        for s in ("ACCESS_AUD", "ROLE_MAP_JSON", "EVIDENCE_HMAC_KEY"):
            out.append(
                Check("ok", f"Worker secret {s}")
                if s in secrets.stdout
                else Check(
                    "missing", f"Worker secret {s}", "not set", "npm run setup:prod -- --cloudflare-only"
                )
            )
    else:
        out.append(
            Check(
                "missing",
                "wrangler.prod.jsonc rendered",
                "not rendered",
                "npm run setup:prod -- --cloudflare-only",
            )
        )
    aud = os.environ.get("ACCESS_AUD", "")
    out.append(
        Check("ok", "ACCESS_AUD", "set")
        if aud and aud != "unset"
        else Check(
            "missing",
            "ACCESS_AUD",
            "unset: every API call answers 401",
            "copy the Application Audience tag into .env.prod (README step 12)",
        )
    )
    for key in ("CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET", "BASIN_CATALOG_TOKEN", "EVIDENCE_HMAC_KEY"):
        out.append(
            Check("ok", f".env.prod {key}")
            if os.environ.get(key)
            else Check("missing", f".env.prod {key}", "not set", "see README, production setup")
        )
    team = os.environ.get("ACCESS_TEAM_DOMAIN", "")
    url = os.environ.get("DATATRUST_API_URL") or state().get("worker_url")
    try:
        import requests

        if team:
            certs = requests.get(f"{team.rstrip('/')}/cdn-cgi/access/certs", timeout=30)
            ok = certs.ok and bool(certs.json().get("keys"))
            out.append(
                Check("ok", "Access team JWKS", team)
                if ok
                else Check(
                    "missing", "Access team JWKS", f"HTTP {certs.status_code}", "check ACCESS_TEAM_DOMAIN"
                )
            )
        else:
            out.append(
                Check(
                    "missing",
                    "Access team JWKS",
                    "ACCESS_TEAM_DOMAIN not set",
                    "set it in .env.prod (README step 12)",
                )
            )
        if url:
            anon = requests.get(f"{url}/api/whoami", allow_redirects=False, timeout=30)
            out.append(
                Check("ok", "unauthenticated request denied by Access", f"HTTP {anon.status_code}")
                if anon.status_code in (302, 401, 403)
                else Check(
                    "missing",
                    "unauthenticated request denied by Access",
                    f"HTTP {anon.status_code}",
                    "enable Cloudflare Access on the workers.dev route (README step 11)",
                )
            )
            out.extend(service_token_checks(url))
        else:
            out.append(
                Check(
                    "missing",
                    "Worker URL",
                    "unknown",
                    "deploy with npm run setup:prod, or set DATATRUST_API_URL",
                )
            )
    except Exception as err:  # noqa: BLE001
        out.append(
            Check(
                "missing", "Worker and Access reachability", str(err), "check network and DATATRUST_API_URL"
            )
        )
    try:
        from datatrust.lake.iceberg_basin import list_namespaces

        namespaces = list_namespaces()
        out.append(Check("ok", "Basin Catalog REST (pyiceberg)", f"namespaces {namespaces}"))
    except Exception as err:  # noqa: BLE001
        out.append(
            Check(
                "missing",
                "Basin Catalog REST (pyiceberg)",
                str(err)[:200],
                "set BASIN_CATALOG_URI, BASIN_WAREHOUSE, BASIN_CATALOG_TOKEN",
            )
        )
    return out


def jwt_claims(token: str | None) -> dict[str, Any]:
    """Decoded (not verified) claims of an Access JWT, for display only."""
    import base64

    try:
        part = (token or "").split(".")[1]
        return json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
    except (IndexError, ValueError):
        return {}


def service_token_checks(url: str, get: Callable[..., Any] | None = None) -> list[Check]:
    """Each Access service token reaches the Worker and maps to exactly the roles it should have: the runner
    token to `runner` only, the operator token to `operator` and `viewer` (ROLE_MAP_JSON, SPEC 15)."""
    if get is None:
        import requests

        get = requests.get
    out: list[Check] = []
    for label, prefix, want in (
        ("datatrust-runner", "CF_ACCESS_CLIENT", {"runner"}),
        ("datatrust-operator", "CF_ACCESS_OPERATOR_CLIENT", {"operator", "viewer"}),
    ):
        cid, secret = os.environ.get(f"{prefix}_ID"), os.environ.get(f"{prefix}_SECRET")
        if not (cid and secret):
            out.append(
                Check(
                    "missing",
                    f"service token {label}",
                    f"{prefix}_ID / {prefix}_SECRET not set",
                    "README Cloudflare step 13",
                )
            )
            continue
        res = get(
            f"{url}/api/whoami",
            headers={"CF-Access-Client-Id": cid, "CF-Access-Client-Secret": secret},
            allow_redirects=False,
            timeout=30,
        )
        if res.status_code != 200:
            fix = {
                401: "Access let the request through but the Worker rejected the JWT: check ACCESS_AUD and "
                "ACCESS_TEAM_DOMAIN, then rerun npm run setup:prod -- --cloudflare-only",
                403: "the Worker does not know this token: rerun npm run setup:prod -- --cloudflare-only so "
                "ROLE_MAP_JSON includes it",
            }.get(
                res.status_code,
                f"add {label} to the Service Auth policy of the datatrust Access app (README step 13)",
            )
            out.append(Check("missing", f"service token {label}", f"HTTP {res.status_code}", fix))
            continue
        principal = res.json()
        roles = set(principal.get("roles") or [])
        claims = jwt_claims(getattr(res, "cookies", {}).get("CF_Authorization"))
        seen = {k: claims[k] for k in ("common_name", "sub", "iss", "aud") if k in claims}
        out.append(
            Check(
                "ok",
                f"service token {label}",
                f"principal {principal.get('id')}, roles {sorted(roles)}"
                + (f", JWT claims {seen}" if seen else ""),
            )
            if roles == want
            else Check(
                "missing",
                f"service token {label} roles",
                f"roles {sorted(roles)}, expected {sorted(want)}",
                "rerun npm run setup:prod -- --cloudflare-only (rewrites ROLE_MAP_JSON)",
            )
        )
    return out


def governance_checks(project: str, location: str) -> list[Check]:
    """Taxonomy, its three policy tags, and one v1 masking data policy bound to each tag."""
    try:
        from google.cloud import bigquery_datapolicies_v1 as dp
        from google.cloud import datacatalog_v1 as dc

        from datatrust.prod.governance import TAGS, TAXONOMY

        parent = f"projects/{project}/locations/{location.lower()}"
        ptm = dc.PolicyTagManagerClient()
        tax = next((t for t in ptm.list_taxonomies(parent=parent) if t.display_name == TAXONOMY), None)
        if tax is None:
            return [
                Check(
                    "missing", f"taxonomy {TAXONOMY}", "not found", "uv run datatrust prod governance apply"
                )
            ]
        tags = {t.display_name: t.name for t in ptm.list_policy_tags(parent=tax.name)}
        bound = {
            p.policy_tag.rsplit("/", 1)[-1]
            for p in dp.DataPolicyServiceClient().list_data_policies(parent=parent)
            if p.policy_tag
        }
        out = [Check("ok", f"taxonomy {TAXONOMY}", tax.name)]
        for key in TAGS:
            if key not in tags:
                out.append(
                    Check(
                        "missing", f"policy tag {key}", "not found", "uv run datatrust prod governance apply"
                    )
                )
            elif tags[key].rsplit("/", 1)[-1] not in bound:
                out.append(
                    Check(
                        "missing",
                        f"masking policy on {key}",
                        "no data policy bound to the tag",
                        "uv run datatrust prod governance apply",
                    )
                )
            else:
                out.append(Check("ok", f"policy tag {key} with masking policy"))
        return out
    except Exception as err:  # noqa: BLE001
        return [
            Check(
                "missing",
                "policy tags and masking policies",
                f"{type(err).__name__}: {str(err)[:200]}",
                "uv run datatrust prod governance apply",
            )
        ]


# ------------------------------------------------------------------------------------------------ Google Cloud


def gcp_checks() -> list[Check]:
    out: list[Check] = []
    gcloud, bq = shutil.which("gcloud"), shutil.which("bq")
    if not gcloud or not bq:
        out.append(
            Check(
                "missing",
                "gcloud and bq CLIs",
                "not on PATH",
                "brew install --cask gcloud-cli (or the official google-cloud-cli tarball), then gcloud init",
            )
        )
        out.append(
            Check(
                "missing",
                "Google Cloud checks",
                "skipped until gcloud is installed",
                "see README, Google Cloud",
            )
        )
        return out
    out.append(Check("ok", "gcloud and bq CLIs", gcloud))
    account = run(["gcloud", "config", "get-value", "account"]).stdout.strip()
    out.append(
        Check("ok", "gcloud active account", account)
        if account and "unset" not in account
        else Check("missing", "gcloud active account", "none", "gcloud auth login")
    )
    adc = Path(
        os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
        or Path.home() / ".config/gcloud/application_default_credentials.json"
    )
    if adc.exists():
        quota = json.loads(adc.read_text()).get("quota_project_id")
        out.append(
            Check("ok", "ADC with quota project", quota)
            if quota
            else Check(
                "missing",
                "ADC with quota project",
                "no quota_project_id",
                "gcloud auth application-default set-quota-project $DATATRUST_GCP_PROJECT",
            )
        )
    else:
        out.append(
            Check(
                "missing",
                "application default credentials",
                str(adc),
                "gcloud auth application-default login",
            )
        )
    project = os.environ.get("DATATRUST_GCP_PROJECT", "")
    if not project or project == "datatrust-ci-placeholder":
        out.append(
            Check(
                "missing",
                "DATATRUST_GCP_PROJECT",
                "not set",
                "set it in .env.prod (README, Google Cloud step 7)",
            )
        )
        return out
    out.append(Check("ok", "DATATRUST_GCP_PROJECT", project))
    billing = run(
        ["gcloud", "billing", "projects", "describe", project, "--format=value(billingEnabled)"]
    ).stdout.strip()
    out.append(
        Check("ok", "billing enabled")
        if billing == "True"
        else Check(
            "missing",
            "billing enabled",
            billing or "unknown",
            f"gcloud billing projects link {project} --billing-account=<ID>",
        )
    )
    enabled = run(
        ["gcloud", "services", "list", "--enabled", f"--project={project}", "--format=value(config.name)"]
    ).stdout
    for api in GCP_APIS:
        out.append(
            Check("ok", f"API {api}")
            if api in enabled
            else Check(
                "missing", f"API {api}", "not enabled", f"gcloud services enable {api} --project={project}"
            )
        )
    for ds in ("datatrust_raw", "datatrust_staging", "datatrust_marts", "datatrust_restricted"):
        show = run(["bq", "show", "--format=prettyjson", f"{project}:{ds}"])
        if show.returncode != 0:
            out.append(Check("missing", f"dataset {ds}", "not found", "npm run setup:prod -- --gcp-only"))
            continue
        hours = str(json.loads(show.stdout or "{}").get("maxTimeTravelHours", ""))
        out.append(
            Check("ok", f"dataset {ds}", "time travel 168 h")
            if hours == "168"
            else Check(
                "missing",
                f"dataset {ds} time travel",
                f"{hours or 'default'} h",
                f"bq update --dataset=true --max_time_travel_hours=168 {project}:{ds}",
            )
        )
    for sa in ("datatrust-analyst", "datatrust-prober"):
        email = f"{sa}@{project}.iam.gserviceaccount.com"
        exists = (
            run(["gcloud", "iam", "service-accounts", "describe", email, f"--project={project}"]).returncode
            == 0
        )
        if not exists:
            out.append(
                Check("missing", f"service account {sa}", "not found", "npm run setup:prod -- --gcp-only")
            )
            continue
        token = run(["gcloud", "auth", "print-access-token", f"--impersonate-service-account={email}"])
        out.append(
            Check("ok", f"impersonate {sa}")
            if token.returncode == 0
            else Check(
                "missing",
                f"impersonate {sa}",
                "cannot mint a token",
                "npm run setup:prod -- --gcp-only (grants Service Account Token Creator)",
            )
        )
    out.extend(governance_checks(project, os.environ.get("DATATRUST_BQ_LOCATION", "US")))
    try:
        from datatrust.prod.settings import dbt_vars

        tags = dbt_vars()
        out.append(Check("ok", ".prod/dbt_vars.yml policy tags", ", ".join(sorted(tags))))
    except Exception as err:  # noqa: BLE001
        out.append(
            Check(
                "missing",
                ".prod/dbt_vars.yml policy tags",
                str(err),
                "uv run datatrust prod governance apply",
            )
        )
    return out


def main(mode: str = "local") -> int:
    from datatrust.prod.settings import load_env_prod

    groups: list[tuple[str, Callable[[], list[Check]]]] = [("Local", local_checks)]
    if mode == "prod":
        load_env_prod()
        groups = [
            ("Production: .env.prod", env_checks),
            ("Production: Cloudflare", cloudflare_checks),
            ("Production: Google Cloud", gcp_checks),
        ]
    missing = 0
    for title, fn in groups:
        print(f"== {title}")
        for c in fn():
            print(c.line())
            if c.status == "missing" and c.required:
                missing += 1
    print(f"== {missing} required item(s) missing" if missing else "== everything required is in place")
    return 1 if missing else 0
