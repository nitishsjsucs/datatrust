# Production runner on GitHub Actions (Workload Identity Federation)

Stretch item (SPEC 23, commit 23). Implemented, not executed. In v1 the production runner runs on Nitish's
machine with his application-default credentials (SPEC 14.3). This optional workflow,
`.github/workflows/prod-runner.yml`, runs the same runner on GitHub Actions without a service-account key.
It stays off unless started by hand, or unless the repository variable `DATATRUST_SCHEDULED_RUNNER` is `true`.

## One-time Google Cloud setup

The project `master-magnet-444903-u4` is shared by four repos (SPEC 28.5.10), so every resource below is named
`datatrust*` and every grant is scoped to DataTrust's own datasets, taxonomy and service accounts. The runner
gets no project-level data role: in particular not Project Viewer, which would give it READER on every
dataset in the project through BigQuery's default dataset access. Its only project-level role is BigQuery Job
User, which lets it run jobs and reads no data.

The federation trusts one workflow only: `prod-runner.yml` on `refs/heads/main` of this repository, matched by
the repository's numeric id (`1413751218`, from `gh api repos/nitishsjsucs/datatrust --jq .id` on 2026-10-11),
which a renamed or re-created repository cannot reuse. A condition on the repository name alone would let any
workflow on any branch, tag or pull-request event of this public repository that asks for `id-token: write`
become the runner service account, which owns the four DataTrust datasets (2026-10-11 review). The claims
`repository_id`, `ref` and `workflow_ref` are in GitHub's OIDC token reference (checked 2026-10-11).

```sh
P=master-magnet-444903-u4
NUM=$(gcloud projects describe $P --format='value(projectNumber)')

# Service account the workflow becomes
gcloud iam service-accounts create datatrust-runner-ci --project=$P --display-name="DataTrust CI runner"
SA=datatrust-runner-ci@$P.iam.gserviceaccount.com
gcloud projects add-iam-policy-binding $P --member=serviceAccount:$SA --role=roles/bigquery.jobUser --condition=None
# dbt replaces tables and views and re-applies policy tags with persist_docs. Setting a policy tag needs
# bigquery.tables.setCategory (BigQuery Data Owner, granted on the DataTrust datasets only) and
# datacatalog.taxonomies.get (in Policy Tags Admin and Project Viewer, per the BigQuery column-level security
# docs). Policy Tags Admin is granted on the datatrust-classification taxonomy only, by governance apply below.
for D in datatrust_raw datatrust_staging datatrust_marts datatrust_restricted; do
  bq add-iam-policy-binding --member=serviceAccount:$SA --role=roles/bigquery.dataOwner $P:$D
done
# The runner impersonates datatrust-prober for probes, so it needs Token Creator on the prober only
gcloud iam service-accounts add-iam-policy-binding datatrust-prober@$P.iam.gserviceaccount.com --project=$P \
  --member=serviceAccount:$SA --role=roles/iam.serviceAccountTokenCreator --condition=None
# dbt tests read masked columns, so the runner also needs Fine-Grained Reader on the three DataTrust policy
# tags; and Policy Tags Admin on the DataTrust taxonomy for datacatalog.taxonomies.get
uv run datatrust prod governance apply --extra-reader serviceAccount:$SA --taxonomy-admin serviceAccount:$SA

# Workload identity pool and GitHub OIDC provider, restricted to prod-runner.yml on main of this repository
# (immutable numeric repository id; GitHub's OIDC token carries repository_id, ref and workflow_ref)
REPO_ID=1413751218
WORKFLOW_REF=nitishsjsucs/datatrust/.github/workflows/prod-runner.yml@refs/heads/main
gcloud iam workload-identity-pools create datatrust-github --project=$P --location=global \
  --display-name="DataTrust GitHub Actions"
gcloud iam workload-identity-pools providers create-oidc datatrust --project=$P --location=global \
  --workload-identity-pool=datatrust-github --issuer-uri=https://token.actions.githubusercontent.com \
  --attribute-mapping=google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.ref=assertion.ref,attribute.workflow_ref=assertion.workflow_ref \
  --attribute-condition="assertion.repository_id=='$REPO_ID' && assertion.ref=='refs/heads/main' && assertion.workflow_ref=='$WORKFLOW_REF'"
gcloud iam service-accounts add-iam-policy-binding $SA --project=$P --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$NUM/locations/global/workloadIdentityPools/datatrust-github/attribute.repository_id/$REPO_ID"
```

Optional, stronger: put the job in a protected GitHub environment (for example `datatrust-production`, with
required reviewers) by adding `environment: datatrust-production` to the job in `prod-runner.yml`, and add
`&& assertion.environment=='datatrust-production'` to the condition above. Not done by default, because
GitHub creates a missing environment on the first run without protection rules.

UNVERIFIED (no Google Cloud account was used to write this): that a Policy Tags Admin grant on the taxonomy,
rather than on the project, satisfies the `datacatalog.taxonomies.get` check when dbt sets policy tags. The
first workflow run proves it: if dbt fails with a permission error on `datacatalog.taxonomies.get`, the grant
is not enough, and the fallback is to run the production runner on your machine (README), never to grant
Project Viewer on the shared project.

## GitHub settings

Repository variables: `DATATRUST_API_URL` (the Worker URL), `DATATRUST_GCP_PROJECT`, `DATATRUST_BQ_LOCATION`,
`DATATRUST_RUNNER_SA` (`datatrust-runner-ci@<project>.iam.gserviceaccount.com`), `DATATRUST_WIF_PROVIDER`
(`projects/<number>/locations/global/workloadIdentityPools/datatrust-github/providers/datatrust`),
`DATATRUST_DBT_VARS_YAML` (the contents of `.prod/dbt_vars.yml`, policy-tag resource names, not secret), and
optionally `DATATRUST_SCHEDULED_RUNNER=true`. Optionally also `BASIN_CATALOG_URI` and `BASIN_WAREHOUSE` (from
`.env.prod`) with the secret `BASIN_CATALOG_TOKEN` (the bucket-scoped token of `docs/basin-catalog-token.md`), so the runner commits the audit lake to Basin Catalog every
15 minutes and before it exits.

Repository secrets: `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` (service token `datatrust-runner`),
`EVIDENCE_HMAC_KEY` (the value `setup:prod` saved in `.env.prod`, so the CI runner's sample-key tokens match
the laptop runner's; the Worker never holds it) and, only if you use the "start a
run" option, `CF_ACCESS_OPERATOR_CLIENT_ID` and `CF_ACCESS_OPERATOR_CLIENT_SECRET` (service token
`datatrust-operator`; the runner token cannot start runs).

## Run it

Actions, prod-runner, Run workflow (tick "Also POST /api/runs" to start a clean seed-101 run). The job drains
queued `dbt_build` and `diagnostics` jobs and exits after ten minutes without work.
