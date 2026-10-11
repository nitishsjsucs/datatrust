# Runner image for scripts/bq-emulator-check.sh: Node 24, uv, and the helper scripts. The repository itself
# arrives at run time through `git archive HEAD`, so the check covers exactly what is committed.
FROM node:24-bookworm
COPY --from=ghcr.io/astral-sh/uv:0.12.17 /uv /uvx /bin/
ENV DBT_SEND_ANONYMOUS_USAGE_STATS=false CI=true
WORKDIR /work
COPY setup.sh load.py probes.py emu_patch.py /bqemu/
