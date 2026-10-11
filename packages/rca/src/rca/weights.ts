/**
 * FROZEN ranking weights (ADR-0004). Tuned only on dev seeds 1-3 and frozen here before the test-seed run
 * (seeds 101-105). Changing these after the test-seed run invalidates the reported results.
 */
import type { Weights } from '../types';

export const INITIAL_WEIGHTS: Weights = { coverage: 0.4, anomaly: 0.35, changed: 0.15, unexplainedPass: 0.1 };

/**
 * Frozen on 2026-10-10 from `uv run datatrust tune --from results/bench-2026-10-10-offline-dev.json`
 * (dev seeds 1-3, 60 injected trials: top-3 100%, top-1 90%, MRR 0.950). See docs/adr/0004.
 */
export const FROZEN_WEIGHTS: Weights = { coverage: 0.4, anomaly: 0.3, changed: 0.15, unexplainedPass: 0.1 };

/** The grid searched on dev seeds (SPEC 12.3); LOSO re-tunes over the same grid. */
export function weightGrid(): Weights[] {
  const steps = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6];
  const out: Weights[] = [];
  for (const coverage of steps)
    for (const anomaly of steps)
      for (const changed of [0, 0.05, 0.1, 0.15, 0.2, 0.3])
        for (const unexplainedPass of [0, 0.05, 0.1, 0.2]) {
          if (coverage + anomaly === 0) continue;
          out.push({ coverage, anomaly, changed, unexplainedPass });
        }
  return out;
}
