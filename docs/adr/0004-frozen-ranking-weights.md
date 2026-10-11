# ADR-0004: Frozen ranking weights

- Status: accepted, 2026-10-10

## Context

The root-cause ranker scores candidates with four weighted features (coverage, own anomaly, change signal, unexplained passes). Tuning those weights on the same trials that are reported would overstate accuracy.

## Decision

Weights are tuned only on dev seeds 1, 2 and 3 (20 scenarios x 3 seeds = 60 injected trials, plus 3 clean trials) by grid search (`packages/rca/src/rca/weights.ts`, `weightGrid()`): best top-3, then top-1, then MRR, then the point closest to the initial weights. `datatrust tune` refuses any report that contains a non-dev seed.

Tuning run on 2026-10-10:

- `uv run datatrust bench --seeds 1-3 --workers 6 --tag dev` wrote `results/bench-2026-10-10-offline-dev.json` (60/60 detected, 0 clean false positives).
- `uv run datatrust tune --from results/bench-2026-10-10-offline-dev.json` returned coverage 0.40, anomaly 0.30, changed 0.15, unexplained_pass 0.10 (dev top-3 100%, top-1 90%, MRR 0.950).

These values are frozen as `FROZEN_WEIGHTS` before the test seeds 101-105 run, and the test-seed results are reported whatever they are.

Correction (2026-10-11 review): seed 101 was not fully held out. It was also the development smoke seed: before the freeze commit (`86ef4f1`), commit `1d95d3d` added `pipelines/tests/test_injection_detected_smoke.py`, which runs S01, T14 and S04 plus a clean trial on seed 101 with the initial weights and asserts detection and that the ground truth is in the ranked list. The README therefore also reports seeds 102-105 alone as the cleanly held-out figure (80/80 detected, 80/80 top-3, 72/80 top-1, `uv run datatrust report --from results/bench-2026-10-10-offline.json --seeds 102-105 --tag heldout-102-105`).

## Consequences

- The dev-seed figures are tuning figures, not results, and the README does not quote them as results.
- Scenarios, severity ranges and decoys were also authored before the test-seed run. Weights are tuned over the same 20 scenarios, so the test seeds hold out values and severities, not defect types; the leave-one-scenario-out figure (each scenario's weights tuned without it) is reported next to the main result.
- Changing the weights, the scenarios or the probes after the test-seed run requires a new dev tuning run, a new ADR revision and a fresh test-seed run.
