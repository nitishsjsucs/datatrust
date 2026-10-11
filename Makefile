.PHONY: setup test typecheck bench bench-e2e doctor bootstrap dev-up dev-down

setup:
	npm ci
	uv sync --locked

typecheck:
	npm run typecheck

test:
	npm run build -w @datatrust/rca
	npm test

bench:
	npm run build -w @datatrust/rca
	uv run datatrust bench --mode offline --seeds 101-105 --dev-results results/bench-2026-10-10-offline-dev.json

bench-e2e:
	npm run bench:e2e

doctor:
	npm run doctor

bootstrap:
	npm run setup:prod

dev-up:
	npm run dev:up

dev-down:
	npm run dev:down
