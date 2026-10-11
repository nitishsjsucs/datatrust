.PHONY: setup test typecheck bench

setup:
	npm ci
	uv sync --locked

typecheck:
	npm run typecheck

test:
	npm test

bench:
	npm run build -w @datatrust/rca
	uv run datatrust bench --mode offline --seeds 101-105
