# DataTrust benchmark, offline mode, 2026-10-10

- Command: `uv run datatrust bench --mode offline --seeds 101-105 --workers 4 --dev-results results/bench-2026-10-10-offline-dev.json --out .data/recheck`
- Git commit: `019714f6703271f9c99a0b42546c53fae1d3a094`
- Seeds: 101, 102, 103, 104, 105; scenarios: 20; injected trials: 100; clean trials: 5
- Warehouse: DuckDB 1.5.6 via dbt-duckdb 1.11.0, local stand-in for BigQuery
- Weights: `{"coverage": 0.4, "anomaly": 0.3, "changed": 0.15, "unexplainedPass": 0.1}`
- Wall time: 305.0 s

## Headline

| Metric | Value | Wilson 95% | Scenario-clustered bootstrap 95% |
|---|---|---|---|
| Detection recall (target 95%) | 100.0% (100/100) | 96.3% to 100.0% | 100.0% to 100.0% |
| Top-3 root-cause accuracy, all injected trials (target 90%) | 100.0% (100/100) | 96.3% to 100.0% | 100.0% to 100.0% |
| Top-1 root-cause accuracy, all injected trials | 90.0% | 82.6% to 94.5% | 75.0% to 100.0% |

- Clean false positives (failing checks over the clean trials): 0
- Over detected trials only: top-1 90.0%, top-3 100.0%
- MRR (all injected): 0.950; column-level top-3: 100.0% over 75 trials with a column label
- Candidate-set size: median 4.0, IQR 2.0 to 6.0
- Column-lineage coverage (share of model columns with a column edge): 86.6%
- Ranker top-3 gain over the best naive baseline (change_only, 77.0%): 23.0 percentage points
- Leave-one-scenario-out top-3: 100.0% over 100 trials (weights re-tuned on dev seeds without the held-out scenario). The main result holds out seeds, values and severities but not defect types, because weights were tuned on dev seeds over the same 20 scenarios; LOSO is the closer estimate for unseen defect types.

## Ablations and baselines (all injected trials)

| Ranking | Top-1 | Top-3 | MRR |
|---|---|---|---|
| Full ranker | 90.0% | 100.0% | 0.950 |
| ablation: coverage_only | 15.0% | 85.0% | 0.510 |
| ablation: dataset_lineage_only | 90.0% | 98.0% | 0.940 |
| ablation: no_probes | 27.0% | 95.0% | 0.604 |
| ablation: no_change_signal | 90.0% | 100.0% | 0.950 |
| baseline: change_only | 27.0% | 77.0% | 0.537 |
| baseline: nearest_upstream_source | 42.0% | 60.0% | 0.522 |
| baseline: random_in_closure (expected) | n/a | 73.4% | n/a |

## Per kind

| Kind | Trials | Detection | Top-1 | Top-3 |
|---|---|---|---|---|
| source | 65 | 100.0% | 84.6% | 100.0% |
| transformation | 35 | 100.0% | 100.0% | 100.0% |

## Per scenario

| Scenario | Kind | Trials | Detected | Top-1 | Top-3 | Ground-truth rank per trial |
|---|---|---|---|---|---|---|
| S01 duplicate hires (new hire_id, same application) | source | 5 | 5 | 5 | 5 | 1, 1, 1, 1, 1 |
| S02 orphan applications (unknown requisition) | source | 5 | 5 | 5 | 5 | 1, 1, 1, 1, 1 |
| S03 stale exchange rates (one currency frozen) | source | 5 | 5 | 5 | 5 | 1, 1, 1, 1, 1 |
| S04 timezone mismatch: recruiter events in local time labelled UTC | source | 5 | 5 | 5 | 5 | 1, 1, 1, 1, 1 |
| S05 overlapping assignment intervals | source | 5 | 5 | 5 | 5 | 1, 1, 1, 1, 1 |
| S06 missing FX days | source | 5 | 5 | 5 | 5 | 1, 1, 1, 1, 1 |
| S07 inverted FX rate (units per USD stored as USD per unit) | source | 5 | 5 | 5 | 5 | 1, 1, 1, 1, 1 |
| S08 out-of-order stage transitions | source | 5 | 5 | 5 | 5 | 1, 1, 1, 1, 1 |
| S09 payroll double posting for one department-month | source | 5 | 5 | 5 | 5 | 1, 1, 1, 1, 1 |
| S10 compensation currency mismatched to location | source | 5 | 5 | 0 | 5 | 2, 2, 2, 2, 2 |
| S11 payroll after termination | source | 5 | 5 | 0 | 5 | 2, 2, 2, 2, 2 |
| S12 hires linked to unknown employees | source | 5 | 5 | 5 | 5 | 1, 1, 1, 1, 1 |
| S13 schema drift: salary delivered as text with separators | source | 5 | 5 | 5 | 5 | 1, 1, 1, 1, 1 |
| T14 join fan-out: FX joined on currency only in int_compensation_usd | transformation | 5 | 5 | 5 | 5 | 1, 1, 1, 1, 1 |
| T15 join fan-out: dim_employee joins all assignments, not current | transformation | 5 | 5 | 5 | 5 | 1, 1, 1, 1, 1 |
| T16 timezone bug: stg_stage_events local date computed in UTC | transformation | 5 | 5 | 5 | 5 | 1, 1, 1, 1, 1 |
| T17 interval predicate inclusive at both ends in the comp as-of join | transformation | 5 | 5 | 5 | 5 | 1, 1, 1, 1, 1 |
| T18 annualization bug: expected gross divides by 26 | transformation | 5 | 5 | 5 | 5 | 1, 1, 1, 1, 1 |
| T19 stage code mapping swaps screen and onsite | transformation | 5 | 5 | 5 | 5 | 1, 1, 1, 1, 1 |
| T20 headcount metric drops the termination filter | transformation | 5 | 5 | 5 | 5 | 1, 1, 1, 1, 1 |
