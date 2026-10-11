# Build progress

Tracks the SPEC.md section 23 commit plan. Updated with every commit.

## Position

Commit 2 of 19 (core) done: `chore: scaffold npm workspaces, uv project and CI`.

## Done

- 1. SPEC.md, README skeleton (status all "planned"), LICENSE (MIT), .gitignore, this file.
- 2. npm workspaces (`packages/rca`, `apps/worker`), package-lock.json (includes Linux workerd and esbuild binaries), tsconfig.base.json, pyproject.toml + uv.lock (136 packages, dbt-core 1.12.5 / dbt-duckdb 1.11.0 / dbt-bigquery 1.12.1), CI with `node` and `python` jobs, .env.example, Makefile.

## Next

- 3. `feat(synth): seeded workforce generator with exact counts`.

## Check status (at this commit, 2026-10-10, macOS)

- `npm run typecheck`: pass
- `npm run test:rca`: 1 passed
- `npm run test:worker`: no tests yet (`--passWithNoTests`, removed when the Worker lands in commit 11)
- `uv run ruff check`: pass
- `uv run pytest`: 2 passed

## Deviations from SPEC.md

- `apps/web` (stretch) is not in the npm workspaces list until it exists.
