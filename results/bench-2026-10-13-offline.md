# DataTrust benchmark, offline mode, 2026-10-13

- Command: `uv run datatrust bench --mode offline --seeds 101-105 --workers 6 --dev-results results/bench-2026-10-10-offline-dev.json --gate results/baseline.json`
- Git commit: `1d7c62e2db8a6328f8385397bc1244a4cbe9a85a`
- Seeds: 101, 102, 103, 104, 105; scenarios: 20; injected trials: 100; clean trials: 5
- Warehouse: DuckDB 1.5.6 via dbt-duckdb 1.11.0, local stand-in for BigQuery
- Weights: `{"coverage": 0.4, "anomaly": 0.3, "changed": 0.15, "unexplainedPass": 0.1}`
- Wall time: 420.5 s

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

## Metric-triggered trace (metric watch)

Each trial's four metric tables are compared cell by cell with a clean, unpatched build of the same seed (the last green run). A metric with a moved cell has failed; the alert names the metric with the largest share of moved cells, as the runner does. The trial is then traced from that alert alone: its failing dbt checks are withheld, its passing checks kept, and the same probes and frozen-weight ranker run (`dbt-ol run` first builds the models dbt build skipped behind a failing test).

- Injected trials with a failed metric: 45/100 (Wilson 95% 35.6% to 54.8%)
- Metric alerts on clean trials (false alarms): 0/5
- Traced from the failed metric alone, over those 45 trials: top-1 88.9%, top-3 88.9% (40/45; Wilson 95% 76.5% to 95.2%; scenario-clustered bootstrap 95% 65.1% to 100.0%), MRR 0.889
- Alerted metrics: metric_headcount_monthly 13, metric_hires_monthly 8, metric_payroll_cost_usd_monthly 19, metric_time_to_hire 5

| Scenario | Trials | Metric alerts | Alerted metric | Top-1 | Top-3 | Ground-truth rank per trial |
|---|---|---|---|---|---|---|
| S01 duplicate hires (new hire_id, same application) | 5 | 5 | metric_hires_monthly | 5 | 5 | 1, 1, 1, 1, 1 |
| S02 orphan applications (unknown requisition) | 5 | 3 | metric_hires_monthly | 3 | 3 | no alert, 1, 1, no alert, 1 |
| S03 stale exchange rates (one currency frozen) | 5 | 5 | metric_payroll_cost_usd_monthly | 5 | 5 | 1, 1, 1, 1, 1 |
| S04 timezone mismatch: recruiter events in local time labelled UTC | 5 | 0 | - | 0 | 0 | no alert, no alert, no alert, no alert, no alert |
| S05 overlapping assignment intervals | 5 | 3 | metric_headcount_monthly | 3 | 3 | 1, no alert, 1, 1, no alert |
| S06 missing FX days | 5 | 3 | metric_payroll_cost_usd_monthly | 3 | 3 | no alert, 1, 1, no alert, 1 |
| S07 inverted FX rate (units per USD stored as USD per unit) | 5 | 1 | metric_payroll_cost_usd_monthly | 1 | 1 | no alert, 1, no alert, no alert, no alert |
| S08 out-of-order stage transitions | 5 | 0 | - | 0 | 0 | no alert, no alert, no alert, no alert, no alert |
| S09 payroll double posting for one department-month | 5 | 5 | metric_payroll_cost_usd_monthly | 5 | 5 | 1, 1, 1, 1, 1 |
| S10 compensation currency mismatched to location | 5 | 5 | metric_payroll_cost_usd_monthly | 0 | 0 | miss, miss, miss, miss, miss |
| S11 payroll after termination | 5 | 0 | - | 0 | 0 | no alert, no alert, no alert, no alert, no alert |
| S12 hires linked to unknown employees | 5 | 0 | - | 0 | 0 | no alert, no alert, no alert, no alert, no alert |
| S13 schema drift: salary delivered as text with separators | 5 | 0 | - | 0 | 0 | no alert, no alert, no alert, no alert, no alert |
| T14 join fan-out: FX joined on currency only in int_compensation_usd | 5 | 0 | - | 0 | 0 | no alert, no alert, no alert, no alert, no alert |
| T15 join fan-out: dim_employee joins all assignments, not current | 5 | 0 | - | 0 | 0 | no alert, no alert, no alert, no alert, no alert |
| T16 timezone bug: stg_stage_events local date computed in UTC | 5 | 5 | metric_time_to_hire | 5 | 5 | 1, 1, 1, 1, 1 |
| T17 interval predicate inclusive at both ends in the comp as-of join | 5 | 5 | metric_headcount_monthly | 5 | 5 | 1, 1, 1, 1, 1 |
| T18 annualization bug: expected gross divides by 26 | 5 | 0 | - | 0 | 0 | no alert, no alert, no alert, no alert, no alert |
| T19 stage code mapping swaps screen and onsite | 5 | 0 | - | 0 | 0 | no alert, no alert, no alert, no alert, no alert |
| T20 headcount metric drops the termination filter | 5 | 5 | metric_headcount_monthly | 5 | 5 | 1, 1, 1, 1, 1 |
