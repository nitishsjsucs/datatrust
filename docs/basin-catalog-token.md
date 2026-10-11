# Basin Catalog token scoped to `datatrust-lake`

`datatrust lake commit --catalog basin` (the production runner runs it every 15 minutes and on exit) and the
smoke's read-back write and read the Basin Catalog (R2 Data Catalog) table `datatrust.audit_events` on the R2
bucket `datatrust-lake`, and nothing else. They read the token from `BASIN_CATALOG_TOKEN` in `.env.prod` (and
from the repository secret of the same name if you use `docs/prod-runner-wif.md`).

The Cloudflare account is shared by four repos, so the token must not reach their buckets. The R2 dashboard's
"Admin Read & Write" token covers every bucket in the account (read, write, delete and bucket settings), and
the dashboard can scope only its Object permissions to buckets, which do not include the catalog (R2 API
tokens docs, checked 2026-10-11). So the token is created through the API, with the two permission groups the
R2 Data Catalog docs name for a read-write engine, scoped to `datatrust-lake` only (Manage catalogs, "Create
API token via API", checked 2026-10-11):

| Permission group | Id (from the R2 Data Catalog docs) |
|---|---|
| Workers R2 Data Catalog Write | `d229766a2f7f4d299f20eaa8c9b1fde9` |
| Workers R2 Storage Bucket Item Write | `2efd5506f9c8494dacb1fa10a3e7d5b6` |

1. Create a short-lived token that may create tokens: https://dash.cloudflare.com/profile/api-tokens, Create
   Token, template **Create Additional Tokens**, with an expiry later today. Copy it (shown once).
2. Create `datatrust-lake-committer` with it (the account id is DataTrust's account; the bucket is not in a
   jurisdiction, hence `default`):

   ```sh
   read -rs CF_TOKEN_CREATOR   # paste the token from step 1, then Enter
   ACCOUNT=dc93c3bc8aa4f9e09a0d7e7354a80873
   curl -fsS https://api.cloudflare.com/client/v4/user/tokens \
     -H "Authorization: Bearer $CF_TOKEN_CREATOR" -H 'content-type: application/json' \
     --data '{"name":"datatrust-lake-committer","policies":[{"effect":"allow","resources":{"com.cloudflare.edge.r2.bucket.'"$ACCOUNT"'_default_datatrust-lake":"*"},"permission_groups":[{"id":"d229766a2f7f4d299f20eaa8c9b1fde9"},{"id":"2efd5506f9c8494dacb1fa10a3e7d5b6"}]}]}' \
     | python3 -c 'import json, sys; print(json.load(sys.stdin)["result"]["value"])'
   unset CF_TOKEN_CREATOR
   ```

   If the call rejects a permission group id, list the current ids with
   `curl -fsS https://api.cloudflare.com/client/v4/user/tokens/permission_groups -H "Authorization: Bearer $CF_TOKEN_CREATOR"`
   and use those of the two names above.
3. Save the printed value as `BASIN_CATALOG_TOKEN` in `.env.prod` (`npm run setup:wizard` asks for it), then
   delete the step 1 token in the dashboard.

`npm run doctor -- --prod` then lists the catalog's namespaces through the pyiceberg REST client with this
token. A reader that only queries the table can use a second token with **Workers R2 Data Catalog Read** and
**Workers R2 Storage Bucket Item Read** on the same bucket (look up their ids with the permission groups call
above). Not executed: no builder session creates Cloudflare resources.
