.PHONY: setup test typecheck

setup:
	npm ci
	uv sync --locked

typecheck:
	npm run typecheck

test:
	npm test
