# DataTrust benchmark, offline mode, 2026-10-10

- Command: `uv run datatrust bench --seeds 1-3 --workers 6 --tag dev`
- Git commit: `1d95d3dcebfb4022d8e977078d0bafb313318432`
- Seeds: 1, 2, 3; scenarios: 20; injected trials: 60; clean trials: 3
- Warehouse: DuckDB 1.5.6 via dbt-duckdb 1.11.0, local stand-in for BigQuery
- Weights: `{"coverage": 0.4, "anomaly": 0.35, "changed": 0.15, "unexplainedPass": 0.1}`
- Wall time: 80.1 s

## Headline

| Metric | Value | Wilson 95% | Scenario-clustered bootstrap 95% |
|---|---|---|---|
| Detection recall (target 95%) | 100.0% (60/60) | 94.0% to 100.0% | 100.0% to 100.0% |
| Top-3 root-cause accuracy, all injected trials (target 90%) | 100.0% (60/60) | 94.0% to 100.0% | 100.0% to 100.0% |
| Top-1 root-cause accuracy, all injected trials | 90.0% | 79.9% to 95.3% | 75.0% to 100.0% |

- Clean false positives (failing checks over the clean trials): 0
- Over detected trials only: top-1 90.0%, top-3 100.0%
- MRR (all injected): 0.950; column-level top-3: 100.0% over 45 trials with a column label
- Candidate-set size: median 3.5, IQR 2.0 to 6.0
- Column-lineage coverage (share of model columns with a column edge): 86.6%
- Ranker top-3 gain over the best naive baseline (change_only, 80.0%): 20.0 percentage points

## Ablations and baselines (all injected trials)

| Ranking | Top-1 | Top-3 | MRR |
|---|---|---|---|
| Full ranker | 90.0% | 100.0% | 0.950 |
| ablation: coverage_only | 15.0% | 85.0% | 0.510 |
| ablation: dataset_lineage_only | 90.0% | 98.3% | 0.940 |
| ablation: no_probes | 26.7% | 95.0% | 0.604 |
| ablation: no_change_signal | 90.0% | 100.0% | 0.950 |
| baseline: change_only | 26.7% | 80.0% | 0.546 |
| baseline: nearest_upstream_source | 45.0% | 60.0% | 0.537 |
| baseline: random_in_closure (expected) | n/a | 75.1% | n/a |

## Per kind

| Kind | Trials | Detection | Top-1 | Top-3 |
|---|---|---|---|---|
| source | 39 | 100.0% | 84.6% | 100.0% |
| transformation | 21 | 100.0% | 100.0% | 100.0% |

## Per scenario

| Scenario | Kind | Trials | Detected | Top-1 | Top-3 | Ground-truth rank per trial |
|---|---|---|---|---|---|---|
| S01 duplicate hires (new hire_id, same application) | source | 3 | 3 | 3 | 3 | 1, 1, 1 |
| S02 orphan applications (unknown requisition) | source | 3 | 3 | 3 | 3 | 1, 1, 1 |
| S03 stale exchange rates (one currency frozen) | source | 3 | 3 | 3 | 3 | 1, 1, 1 |
| S04 timezone mismatch: recruiter events in local time labelled UTC | source | 3 | 3 | 3 | 3 | 1, 1, 1 |
| S05 overlapping assignment intervals | source | 3 | 3 | 3 | 3 | 1, 1, 1 |
| S06 missing FX days | source | 3 | 3 | 3 | 3 | 1, 1, 1 |
| S07 inverted FX rate (units per USD stored as USD per unit) | source | 3 | 3 | 3 | 3 | 1, 1, 1 |
| S08 out-of-order stage transitions | source | 3 | 3 | 3 | 3 | 1, 1, 1 |
| S09 payroll double posting for one department-month | source | 3 | 3 | 3 | 3 | 1, 1, 1 |
| S10 compensation currency mismatched to location | source | 3 | 3 | 0 | 3 | 2, 2, 2 |
| S11 payroll after termination | source | 3 | 3 | 0 | 3 | 2, 2, 2 |
| S12 hires linked to unknown employees | source | 3 | 3 | 3 | 3 | 1, 1, 1 |
| S13 schema drift: salary delivered as text with separators | source | 3 | 3 | 3 | 3 | 1, 1, 1 |
| T14 join fan-out: FX joined on currency only in int_compensation_usd | transformation | 3 | 3 | 3 | 3 | 1, 1, 1 |
| T15 join fan-out: dim_employee joins all assignments, not current | transformation | 3 | 3 | 3 | 3 | 1, 1, 1 |
| T16 timezone bug: stg_stage_events local date computed in UTC | transformation | 3 | 3 | 3 | 3 | 1, 1, 1 |
| T17 interval predicate inclusive at both ends in the comp as-of join | transformation | 3 | 3 | 3 | 3 | 1, 1, 1 |
| T18 annualization bug: expected gross divides by 26 | transformation | 3 | 3 | 3 | 3 | 1, 1, 1 |
| T19 stage code mapping swaps screen and onsite | transformation | 3 | 3 | 3 | 3 | 1, 1, 1 |
| T20 headcount metric drops the termination filter | transformation | 3 | 3 | 3 | 3 | 1, 1, 1 |
