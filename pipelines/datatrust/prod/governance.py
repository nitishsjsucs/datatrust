"""BigQuery governance (SPEC 17): taxonomy, policy tags, data masking policies and IAM, all idempotent, and a
verification that impersonates the analyst and retries through IAM propagation. Implemented, not executed.

The project is shared by four repos (SPEC 28.5.10), so every grant here is on a DataTrust resource: Fine-
Grained Reader on the three policy tags, Masked Reader on the three data policies, dataset READER on the
DataTrust datasets, and optionally Policy Tags Admin on the DataTrust taxonomy for the CI runner. The only
project-level grant DataTrust makes is BigQuery Job User for its two service accounts (no data access), by
`scripts/setup-prod.sh` with gcloud; Service Account Token Creator is granted on each service account.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import yaml

from datatrust.prod.settings import DBT_VARS, PROD_DIR, GcpSettings

TAXONOMY = "datatrust-classification"
FINE_GRAINED_READER = "roles/datacatalog.categoryFineGrainedReader"
MASKED_READER = "roles/bigquerydatapolicy.maskedReader"
# tag -> (masking rule, description). The dbt var for each tag is pt_<tag>.
TAGS: dict[str, tuple[str, str]] = {
    "pii_string": ("SHA256", "Personal strings: names, emails, phone numbers (SHA-256, pseudonymization)"),
    "pii_date": ("DATE_YEAR_MASK", "Personal dates: birth dates (year only)"),
    "compensation": ("ALWAYS_NULL", "Per-person compensation amounts (NULL for masked readers)"),
}
# Verification reads a few rows of DataTrust tables; 100 MB is far above what they scan (SPEC 28.5.10).
VERIFY_MAX_BYTES = 100 * 1000 * 1000
POLICY_TAG_ADMIN = "roles/datacatalog.categoryAdmin"
PROBER_DATASETS = ("datatrust_raw", "datatrust_staging", "datatrust_marts")
ANALYST_DATASETS = ("datatrust_marts", "datatrust_restricted")


@dataclass
class GovernanceState:
    taxonomy: str = ""
    tags: dict[str, str] = field(default_factory=dict)
    data_policies: dict[str, str] = field(default_factory=dict)
    created: list[str] = field(default_factory=list)


def _location(settings: GcpSettings) -> str:
    return settings.location.lower()


def ensure_taxonomy(ptm: Any, settings: GcpSettings, state: GovernanceState) -> str:
    from google.cloud import datacatalog_v1 as dc

    parent = f"projects/{settings.project}/locations/{_location(settings)}"
    for t in ptm.list_taxonomies(parent=parent):
        if t.display_name == TAXONOMY:
            state.taxonomy = t.name
            return t.name
    tax = ptm.create_taxonomy(
        parent=parent,
        taxonomy=dc.Taxonomy(
            display_name=TAXONOMY,
            description="DataTrust column classification for masking (synthetic workforce data)",
            activated_policy_types=[dc.Taxonomy.PolicyType.FINE_GRAINED_ACCESS_CONTROL],
        ),
    )
    state.taxonomy = tax.name
    state.created.append(f"taxonomy {tax.name}")
    return tax.name


def ensure_tags(ptm: Any, state: GovernanceState) -> dict[str, str]:
    from google.cloud import datacatalog_v1 as dc

    existing = {t.display_name: t.name for t in ptm.list_policy_tags(parent=state.taxonomy)}
    for key, (_, description) in TAGS.items():
        if key in existing:
            state.tags[key] = existing[key]
            continue
        tag = ptm.create_policy_tag(
            parent=state.taxonomy, policy_tag=dc.PolicyTag(display_name=key, description=description)
        )
        state.tags[key] = tag.name
        state.created.append(f"policy tag {tag.name}")
    return state.tags


def ensure_data_policies(dps: Any, settings: GcpSettings, state: GovernanceState) -> dict[str, str]:
    """One masking data policy per policy tag, created with the v1 Data Policy API.

    v1, not v2: a data policy is bound to a policy tag only through the v1 `policy_tag` field. In the v2
    client that field is output only ("supported only for V1 data policies"), because v2 data policies attach
    directly to columns and use `grantees` instead of IAM. A v2 create would therefore leave the tag without a
    masking rule, and the analyst would get "Access Denied" on tagged columns instead of masked values.
    """
    from google.api_core.exceptions import NotFound
    from google.cloud import bigquery_datapolicies_v1 as dp

    parent = f"projects/{settings.project}/locations/{_location(settings)}"
    for key, (rule, _) in TAGS.items():
        policy_id = f"datatrust_{key}"
        name = f"{parent}/dataPolicies/{policy_id}"
        try:
            existing = dps.get_data_policy(name=name)
            bound = getattr(existing, "policy_tag", "")
            if bound and bound.rsplit("/", 1)[-1] != state.tags[key].rsplit("/", 1)[-1]:
                raise RuntimeError(
                    f"data policy {name} is bound to {bound}, not to policy tag {state.tags[key]}; "
                    "delete it (bq or the console) and rerun governance apply"
                )
        except NotFound:
            dps.create_data_policy(
                parent=parent,
                data_policy=dp.DataPolicy(
                    data_policy_id=policy_id,
                    data_policy_type=dp.DataPolicy.DataPolicyType.DATA_MASKING_POLICY,
                    policy_tag=state.tags[key],
                    data_masking_policy=dp.DataMaskingPolicy(
                        predefined_expression=dp.DataMaskingPolicy.PredefinedExpression[rule]
                    ),
                ),
            )
            state.created.append(f"data policy {name} ({rule})")
        state.data_policies[key] = name
    return state.data_policies


def ensure_binding(client: Any, resource: str, role: str, members: list[str]) -> bool:
    """Read-modify-write of an IAM policy (the policy's etag protects against concurrent edits)."""
    policy = client.get_iam_policy(request={"resource": resource})
    binding = next((b for b in policy.bindings if b.role == role), None)
    missing = [m for m in members if binding is None or m not in binding.members]
    if not missing:
        return False
    if binding is None:
        policy.bindings.add(role=role, members=missing)
    else:
        binding.members.extend(missing)
    client.set_iam_policy(request={"resource": resource, "policy": policy})
    return True


def ensure_dataset_readers(bq: Any, settings: GcpSettings, state: GovernanceState) -> None:
    from google.cloud import bigquery

    wanted = {d: [] for d in (*PROBER_DATASETS, *ANALYST_DATASETS)}
    for d in PROBER_DATASETS:
        wanted[d].append(settings.prober_sa)
    for d in ANALYST_DATASETS:
        wanted[d].append(settings.analyst_sa)
    for dataset_id, emails in wanted.items():
        ds = bq.get_dataset(f"{settings.project}.{dataset_id}")
        entries = list(ds.access_entries)
        have = {(e.role, e.entity_id) for e in entries}
        added = False
        for email in emails:
            if ("READER", email) not in have:
                entries.append(
                    bigquery.AccessEntry(role="READER", entity_type="userByEmail", entity_id=email)
                )
                added = True
        if added:
            ds.access_entries = entries
            bq.update_dataset(ds, ["access_entries"])  # etag-checked update
            state.created.append(f"dataset readers on {dataset_id}")


def write_dbt_vars(state: GovernanceState) -> None:
    PROD_DIR.mkdir(parents=True, exist_ok=True)
    DBT_VARS.write_text(yaml.safe_dump({f"pt_{k}": v for k, v in state.tags.items()}, sort_keys=True))


def apply(
    settings: GcpSettings,
    user_email: str,
    *,
    extra_readers: list[str] | None = None,
    taxonomy_admins: list[str] | None = None,
    ptm=None,
    dps=None,
    bq=None,
) -> GovernanceState:
    from google.cloud import bigquery
    from google.cloud import bigquery_datapolicies_v1 as dp
    from google.cloud import datacatalog_v1 as dc

    ptm = ptm or dc.PolicyTagManagerClient()
    dps = dps or dp.DataPolicyServiceClient()
    bq = bq or bigquery.Client(project=settings.project, location=settings.location)
    state = GovernanceState()
    ensure_taxonomy(ptm, settings, state)
    ensure_tags(ptm, state)
    ensure_data_policies(dps, settings, state)
    readers = [f"user:{user_email}", f"serviceAccount:{settings.prober_sa}", *(extra_readers or [])]
    for key, tag in state.tags.items():
        if ensure_binding(ptm, tag, FINE_GRAINED_READER, readers):
            state.created.append(f"fine-grained readers on {key}")
    for key, policy in state.data_policies.items():
        try:
            granted = ensure_binding(dps, policy, MASKED_READER, [f"serviceAccount:{settings.analyst_sa}"])
        except Exception as err:
            # No project-level fallback: on the shared project it would cover other repos' data policies.
            raise RuntimeError(
                f"Masked Reader could not be granted on data policy {policy} ({type(err).__name__}: {err}). "
                "DataTrust grants it per data policy only and never on the shared project (SPEC 28.5.10)."
            ) from err
        if granted:
            state.created.append(f"masked reader on {key}")
    for member in taxonomy_admins or []:
        # Setting policy tags needs datacatalog.taxonomies.get, which Policy Tags Admin includes; granted on
        # the DataTrust taxonomy only, never Project Viewer (SPEC 28.5.10, docs/prod-runner-wif.md).
        if ensure_binding(ptm, state.taxonomy, POLICY_TAG_ADMIN, [member]):
            state.created.append(f"policy tag admin on {TAXONOMY} for {member}")
    ensure_dataset_readers(bq, settings, state)
    write_dbt_vars(state)
    return state


# ------------------------------------------------------------------------------------------- verify


@dataclass
class Assertion:
    name: str
    check: Callable[[Any], None]


def _q(bq: Any, sql: str) -> Any:
    """Every verification query is capped and labelled app=datatrust (shared project, SPEC 28.5.10)."""
    from datatrust.warehouse.bigquery_wh import capped_job_config

    return bq.query(sql, job_config=capped_job_config(VERIFY_MAX_BYTES))


def _assertions(project: str) -> list[Assertion]:
    marts = f"`{project}.datatrust_marts`"

    def hashed_strings(bq: Any) -> None:
        rows = list(_q(bq, f"select first_name, work_email from {marts}.dim_employee limit 20").result())
        assert rows, "dim_employee returned no rows"
        for r in rows:
            for v in (r["first_name"], r["work_email"]):
                assert v is not None and "@" not in v and len(v) >= 32, f"not hashed: {v!r}"

    def year_only_dates(bq: Any) -> None:
        rows = list(_q(bq, f"select birth_date from {marts}.dim_employee limit 20").result())
        assert rows and all(r["birth_date"].month == 1 and r["birth_date"].day == 1 for r in rows), (
            "dates not masked"
        )

    def null_compensation(bq: Any) -> None:
        row = next(
            iter(
                _q(
                    bq, f"select countif(base_salary_usd is not null) n from {marts}.fct_compensation_usd"
                ).result()
            )
        )
        assert row["n"] == 0, f"{row['n']} unmasked compensation values"

    def authorized_view(bq: Any) -> None:
        sql = (
            f"select count(*) n, countif(total_base_salary_usd is null) nulls "
            f"from `{project}.datatrust_restricted`.rpt_compensation_by_dept"
        )
        row = next(iter(_q(bq, sql).result()))
        assert row["n"] > 0 and row["nulls"] == 0, (
            f"authorized view rows {row['n']}, null aggregates {row['nulls']}"
        )

    def staging_denied(bq: Any) -> None:
        from google.api_core.exceptions import Forbidden

        try:
            list(_q(bq, f"select 1 from `{project}.datatrust_staging`.stg_employees limit 1").result())
        except Forbidden:
            return
        raise AssertionError("analyst can read datatrust_staging")

    return [
        Assertion("PII strings are SHA-256 hashed for the analyst", hashed_strings),
        Assertion("birth dates keep the year only", year_only_dates),
        Assertion("per-person compensation is NULL for the analyst", null_compensation),
        Assertion("the authorized view returns non-null aggregates", authorized_view),
        Assertion("the analyst is denied on datatrust_staging", staging_denied),
    ]


def verify(
    settings: GcpSettings,
    *,
    bq=None,
    budget_seconds: float = 600,
    sleep: Callable[[float], None] = time.sleep,
) -> list[dict[str, Any]]:
    """Impersonate datatrust-analyst and check every assertion, retrying each with exponential backoff (10 s
    doubling, 10 minutes in total) because IAM and policy-tag grants take minutes to propagate."""
    if bq is None:
        from google.cloud import bigquery

        from datatrust.warehouse.bigquery_wh import impersonated

        bq = bigquery.Client(
            project=settings.project,
            credentials=impersonated(settings.analyst_sa, settings.project),
            location=settings.location,
        )
    results = []
    deadline = time.monotonic() + budget_seconds
    for a in _assertions(settings.project):
        delay, attempts, error = 10.0, 0, None
        while True:
            attempts += 1
            try:
                a.check(bq)
                error = None
                break
            except Exception as err:  # noqa: BLE001 - reported below
                error = f"{type(err).__name__}: {err}"
                if time.monotonic() + delay > deadline:
                    break
                sleep(delay)
                delay *= 2
        results.append({"assertion": a.name, "ok": error is None, "attempts": attempts, "error": error})
        if error is not None:
            break
    return results
