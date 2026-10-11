# DataTrust benchmark, offline mode, 2026-10-11

- Command: `uv run datatrust bench --mode offline --seeds 101 --workers 4 --out results --tag seed101`
- Git commit: `0957b86dd510536de0f5df8b6c84e15a2a52382e`
- Seeds: 101; scenarios: 20; injected trials: 20; clean trials: 1
- Warehouse: DuckDB 1.5.6 via dbt-duckdb 1.11.0, local stand-in for BigQuery
- Weights: `{"coverage": 0.4, "anomaly": 0.3, "changed": 0.15, "unexplainedPass": 0.1}`
- Wall time: 39.8 s

## Headline

| Metric | Value | Wilson 95% | Scenario-clustered bootstrap 95% |
|---|---|---|---|
| Detection recall (target 95%) | 100.0% (20/20) | 83.9% to 100.0% | 100.0% to 100.0% |
| Top-3 root-cause accuracy, all injected trials (target 90%) | 100.0% (20/20) | 83.9% to 100.0% | 100.0% to 100.0% |
| Top-1 root-cause accuracy, all injected trials | 90.0% | 69.9% to 97.2% | 75.0% to 100.0% |

- Clean false positives (failing checks over the clean trials): 0
- Over detected trials only: top-1 90.0%, top-3 100.0%
- MRR (all injected): 0.950; column-level top-3: 100.0% over 15 trials with a column label
- Candidate-set size: median 3.5, IQR 2.0 to 6.0
- Column-lineage coverage (share of model columns with a column edge): 86.6%
- Ranker top-3 gain over the best naive baseline (change_only, 80.0%): 20.0 percentage points

## Ablations and baselines (all injected trials)

| Ranking | Top-1 | Top-3 | MRR |
|---|---|---|---|
| Full ranker | 90.0% | 100.0% | 0.950 |
| ablation: coverage_only | 15.0% | 85.0% | 0.510 |
| ablation: dataset_lineage_only | 90.0% | 100.0% | 0.942 |
| ablation: no_probes | 30.0% | 95.0% | 0.621 |
| ablation: no_change_signal | 90.0% | 100.0% | 0.950 |
| baseline: change_only | 25.0% | 80.0% | 0.538 |
| baseline: nearest_upstream_source | 45.0% | 60.0% | 0.537 |
| baseline: random_in_closure (expected) | n/a | 75.1% | n/a |

## Per kind

| Kind | Trials | Detection | Top-1 | Top-3 |
|---|---|---|---|---|
| source | 13 | 100.0% | 84.6% | 100.0% |
| transformation | 7 | 100.0% | 100.0% | 100.0% |

## Per scenario

| Scenario | Kind | Trials | Detected | Top-1 | Top-3 | Ground-truth rank per trial |
|---|---|---|---|---|---|---|
| S01 duplicate hires (new hire_id, same application) | source | 1 | 1 | 1 | 1 | 1 |
| S02 orphan applications (unknown requisition) | source | 1 | 1 | 1 | 1 | 1 |
| S03 stale exchange rates (one currency frozen) | source | 1 | 1 | 1 | 1 | 1 |
| S04 timezone mismatch: recruiter events in local time labelled UTC | source | 1 | 1 | 1 | 1 | 1 |
| S05 overlapping assignment intervals | source | 1 | 1 | 1 | 1 | 1 |
| S06 missing FX days | source | 1 | 1 | 1 | 1 | 1 |
| S07 inverted FX rate (units per USD stored as USD per unit) | source | 1 | 1 | 1 | 1 | 1 |
| S08 out-of-order stage transitions | source | 1 | 1 | 1 | 1 | 1 |
| S09 payroll double posting for one department-month | source | 1 | 1 | 1 | 1 | 1 |
| S10 compensation currency mismatched to location | source | 1 | 1 | 0 | 1 | 2 |
| S11 payroll after termination | source | 1 | 1 | 0 | 1 | 2 |
| S12 hires linked to unknown employees | source | 1 | 1 | 1 | 1 | 1 |
| S13 schema drift: salary delivered as text with separators | source | 1 | 1 | 1 | 1 | 1 |
| T14 join fan-out: FX joined on currency only in int_compensation_usd | transformation | 1 | 1 | 1 | 1 | 1 |
| T15 join fan-out: dim_employee joins all assignments, not current | transformation | 1 | 1 | 1 | 1 | 1 |
| T16 timezone bug: stg_stage_events local date computed in UTC | transformation | 1 | 1 | 1 | 1 | 1 |
| T17 interval predicate inclusive at both ends in the comp as-of join | transformation | 1 | 1 | 1 | 1 | 1 |
| T18 annualization bug: expected gross divides by 26 | transformation | 1 | 1 | 1 | 1 | 1 |
| T19 stage code mapping swaps screen and onsite | transformation | 1 | 1 | 1 | 1 | 1 |
| T20 headcount metric drops the termination filter | transformation | 1 | 1 | 1 | 1 | 1 |
