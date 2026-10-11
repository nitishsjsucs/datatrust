# Production runner on GitHub Actions (Workload Identity Federation)

Stretch item (SPEC 23, commit 23). Implemented, not executed. In v1 the production runner runs on Nitish's
machine with his application-default credentials (SPEC 14.3). This optional workflow,
`.github/workflows/prod-runner.yml`, runs the same runner on GitHub Actions without a service-account key.
It stays off unless started by hand, or unless the repository variable `DATATRUST_SCHEDULED_RUNNER` is `true`.

## One-time Google Cloud setup

Replace `P` with the project id and `OWNER/REPO` with `nitishsjsucs/datatrust`.

```sh
P=datatrust-<suffix>
NUM=$(gcloud projects describe $P --format='value(projectNumber)')

# Service account the workflow becomes
gcloud iam service-accounts create datatrust-runner-ci --project=$P --display-name="DataTrust CI runner"
SA=datatrust-runner-ci@$P.iam.gserviceaccount.com
gcloud projects add-iam-policy-binding $P --member=serviceAccount:$SA --role=roles/bigquery.jobUser --condition=None
# dbt replaces tables and views and re-applies policy tags with persist_docs. Setting a policy tag needs
# bigquery.tables.setCategory (BigQuery Data Owner, not Data Editor) and datacatalog.taxonomies.get (Project
# Viewer or Policy Tags Admin), per the BigQuery column-level security docs.
for D in datatrust_raw datatrust_staging datatrust_marts datatrust_restricted; do
  bq add-iam-policy-binding --member=serviceAccount:$SA --role=roles/bigquery.dataOwner $P:$D
done
gcloud projects add-iam-policy-binding $P --member=serviceAccount:$SA --role=roles/viewer --condition=None
# The runner impersonates datatrust-prober for probes, so it needs Token Creator on the prober
gcloud iam service-accounts add-iam-policy-binding datatrust-prober@$P.iam.gserviceaccount.com --project=$P \
  --member=serviceAccount:$SA --role=roles/iam.serviceAccountTokenCreator --condition=None
# dbt tests read masked columns, so the runner also needs Fine-Grained Reader on the three policy tags
uv run datatrust prod governance apply --extra-reader serviceAccount:$SA

# Workload identity pool and GitHub OIDC provider, restricted to this repository
gcloud iam workload-identity-pools create github --project=$P --location=global --display-name="GitHub Actions"
gcloud iam workload-identity-pools providers create-oidc datatrust --project=$P --location=global \
  --workload-identity-pool=github --issuer-uri=https://token.actions.githubusercontent.com \
  --attribute-mapping=google.subject=assertion.sub,attribute.repository=assertion.repository \
  --attribute-condition="assertion.repository=='OWNER/REPO'"
gcloud iam service-accounts add-iam-policy-binding $SA --project=$P --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$NUM/locations/global/workloadIdentityPools/github/attribute.repository/OWNER/REPO"
```

## GitHub settings

Repository variables: `DATATRUST_API_URL` (the Worker URL), `DATATRUST_GCP_PROJECT`, `DATATRUST_BQ_LOCATION`,
`DATATRUST_RUNNER_SA` (`datatrust-runner-ci@<project>.iam.gserviceaccount.com`), `DATATRUST_WIF_PROVIDER`
(`projects/<number>/locations/global/workloadIdentityPools/github/providers/datatrust`),
`DATATRUST_DBT_VARS_YAML` (the contents of `.prod/dbt_vars.yml`, policy-tag resource names, not secret), and
optionally `DATATRUST_SCHEDULED_RUNNER=true`. Optionally also `BASIN_CATALOG_URI` and `BASIN_WAREHOUSE` (from
`.env.prod`) with the secret `BASIN_CATALOG_TOKEN`, so the runner commits the audit lake to Basin Catalog every
15 minutes and before it exits.

Repository secrets: `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` (service token `datatrust-runner`),
`EVIDENCE_HMAC_KEY` (the same value as the Worker secret, so tokens match) and, only if you use the "start a
run" option, `CF_ACCESS_OPERATOR_CLIENT_ID` and `CF_ACCESS_OPERATOR_CLIENT_SECRET` (service token
`datatrust-operator`; the runner token cannot start runs).

## Run it

Actions, prod-runner, Run workflow (tick "Also POST /api/runs" to start a clean seed-101 run). The job drains
queued `dbt_build` and `diagnostics` jobs and exits after ten minutes without work.
