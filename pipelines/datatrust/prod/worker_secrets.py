"""Worker secrets for production (SPEC 15, 18.1 step 10), written to `.prod/secrets.json` (mode 600) and
deployed with `wrangler deploy --secrets-file`.

Principals in ROLE_MAP_JSON:
- DATATRUST_OPERATOR_EMAIL, the address Nitish logs in to Cloudflare Access with: operator and viewer;
- service token `datatrust-runner` (CF_ACCESS_CLIENT_ID): runner only, so a leaked runner credential can
  lease jobs but cannot start runs or read incidents;
- service token `datatrust-operator` (CF_ACCESS_OPERATOR_CLIENT_ID): operator and viewer, for the CLI and
  `npm run prod:smoke`, which start runs and read incidents without a browser login.

ACCESS_AUD stays the literal `unset` until the Access application exists, which makes every authenticated
route answer 401 (fail closed).
"""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from pathlib import Path


def worker_secrets(env: Mapping[str, str]) -> dict[str, str]:
    key = env.get("EVIDENCE_HMAC_KEY", "")
    if len(key) < 32:
        raise ValueError("EVIDENCE_HMAC_KEY must be set (setup-prod generates it) and at least 32 characters")
    emails: dict[str, list[str]] = {}
    if env.get("DATATRUST_OPERATOR_EMAIL"):
        emails[env["DATATRUST_OPERATOR_EMAIL"].strip().lower()] = ["operator", "viewer"]
    tokens: dict[str, list[str]] = {}
    if env.get("CF_ACCESS_CLIENT_ID"):
        tokens[env["CF_ACCESS_CLIENT_ID"].strip().lower()] = ["runner"]
    if env.get("CF_ACCESS_OPERATOR_CLIENT_ID"):
        op = env["CF_ACCESS_OPERATOR_CLIENT_ID"].strip().lower()
        if op in tokens:
            raise ValueError(
                "CF_ACCESS_OPERATOR_CLIENT_ID must be a second service token (datatrust-operator), "
                "not datatrust-runner"
            )
        tokens[op] = ["operator", "viewer"]
    return {
        "EVIDENCE_HMAC_KEY": key,
        "ROLE_MAP_JSON": json.dumps({"emails": emails, "serviceTokens": tokens}, sort_keys=True),
        "ACCESS_AUD": env.get("ACCESS_AUD") or "unset",
    }


def write_worker_secrets(path: Path, env: Mapping[str, str] | None = None) -> dict[str, str]:
    secrets = worker_secrets(os.environ if env is None else env)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        json.dump(secrets, fh)
    os.chmod(path, 0o600)
    return secrets
