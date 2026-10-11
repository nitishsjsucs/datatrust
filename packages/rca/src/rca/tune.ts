/**
 * Weight tuning on dev seeds and leave-one-scenario-out evaluation (SPEC 12.3, ADR-0004).
 * Only dev-seed trials may be passed to `tune`; the frozen result goes into weights.ts by hand.
 */
import type { NodeId, Weights } from '../types';
import { type FeatureRow, scoreRows } from './rank';
import { INITIAL_WEIGHTS, weightGrid } from './weights';

export interface TuneTrial {
  id: string;
  scenario: string;
  groundTruth: NodeId;
  rows: FeatureRow[];
}

export interface Evaluation {
  n: number;
  top1: number;
  top3: number;
  mrr: number;
}

export function evaluate(trials: TuneTrial[], weights: Weights): Evaluation {
  let top1 = 0;
  let top3 = 0;
  let mrr = 0;
  for (const t of trials) {
    const order = scoreRows(t.rows, weights).map((c) => c.node);
    const idx = order.indexOf(t.groundTruth);
    if (idx === 0) top1++;
    if (idx >= 0 && idx < 3) top3++;
    if (idx >= 0) mrr += 1 / (idx + 1);
  }
  const n = trials.length;
  return { n, top1: n ? top1 / n : 0, top3: n ? top3 / n : 0, mrr: n ? mrr / n : 0 };
}

const l1 = (a: Weights, b: Weights) =>
  Math.abs(a.coverage - b.coverage) +
  Math.abs(a.anomaly - b.anomaly) +
  Math.abs(a.changed - b.changed) +
  Math.abs(a.unexplainedPass - b.unexplainedPass);

/** Best weights on the grid: top-3, then top-1, then MRR, then closeness to the initial weights. */
export function tune(trials: TuneTrial[], grid: Weights[] = weightGrid()): { weights: Weights } & Evaluation {
  let best: ({ weights: Weights } & Evaluation) | null = null;
  for (const w of grid) {
    const e = evaluate(trials, w);
    const better =
      best === null ||
      e.top3 > best.top3 + 1e-12 ||
      (Math.abs(e.top3 - best.top3) <= 1e-12 &&
        (e.top1 > best.top1 + 1e-12 ||
          (Math.abs(e.top1 - best.top1) <= 1e-12 &&
            (e.mrr > best.mrr + 1e-12 ||
              (Math.abs(e.mrr - best.mrr) <= 1e-12 && l1(w, INITIAL_WEIGHTS) < l1(best.weights, INITIAL_WEIGHTS) - 1e-12)))));
    if (better) best = { weights: w, ...e };
  }
  if (best === null) throw new Error('empty grid');
  return best;
}

/** For each scenario, tune on the dev trials of the other scenarios and score that scenario's test trials. */
export function leaveOneScenarioOut(
  dev: TuneTrial[],
  test: TuneTrial[],
  grid: Weights[] = weightGrid(),
): { pooled: Evaluation; perScenario: Record<string, { weights: Weights } & Evaluation> } {
  const scenarios = [...new Set(test.map((t) => t.scenario))].sort();
  const perScenario: Record<string, { weights: Weights } & Evaluation> = {};
  let n = 0;
  let top1 = 0;
  let top3 = 0;
  let mrr = 0;
  for (const s of scenarios) {
    const { weights } = tune(
      dev.filter((t) => t.scenario !== s),
      grid,
    );
    const e = evaluate(
      test.filter((t) => t.scenario === s),
      weights,
    );
    perScenario[s] = { weights, ...e };
    n += e.n;
    top1 += e.top1 * e.n;
    top3 += e.top3 * e.n;
    mrr += e.mrr * e.n;
  }
  return { pooled: { n, top1: n ? top1 / n : 0, top3: n ? top3 / n : 0, mrr: n ? mrr / n : 0 }, perScenario };
}
