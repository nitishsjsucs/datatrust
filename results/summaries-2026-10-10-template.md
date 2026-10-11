# Summary faithfulness eval, template, 2026-10-10

- Command: `uv run datatrust bench summaries --provider template --workers 4`
- Git commit: `bbb8e657f923c27f628c322ab9199f4f5b22703e`
- Summarizer: template-v1
- Incidents: 20 (seed 101, every scenario, offline trials on DuckDB, the local stand-in for BigQuery)

| Metric | Value |
|---|---|
| First draft is a JSON object | 100% |
| First draft passes grounding | 100% |
| Accepted after one repair | 0% |
| Template fallback | 0% |
| Accepted drafts naming a top-3 root cause | 20/20 |
| PII leaks (names, emails, phones, birth dates, salaries) | 0 |

Grounding violations by rule, on the final attempt of each incident: none

| Trial | Attempts | Grounded first | Repaired | Fallback | Root cause | In top 3 |
|---|---|---|---|---|---|---|
| s101-S01 | 1 | True | False | False | hires | True |
| s101-S02 | 1 | True | False | False | applications | True |
| s101-S03 | 1 | True | False | False | fx_rates | True |
| s101-S04 | 1 | True | False | False | stage_events | True |
| s101-S05 | 1 | True | False | False | job_assignments | True |
| s101-S06 | 1 | True | False | False | fx_rates | True |
| s101-S07 | 1 | True | False | False | fx_rates | True |
| s101-S08 | 1 | True | False | False | stage_events | True |
| s101-S09 | 1 | True | False | False | payroll_lines | True |
| s101-S10 | 1 | True | False | False | stg_compensation | True |
| s101-S11 | 1 | True | False | False | stg_payroll_lines | True |
| s101-S12 | 1 | True | False | False | hires | True |
| s101-S13 | 1 | True | False | False | compensation | True |
| s101-T14 | 1 | True | False | False | int_compensation_usd | True |
| s101-T15 | 1 | True | False | False | dim_employee | True |
| s101-T16 | 1 | True | False | False | stg_stage_events | True |
| s101-T17 | 1 | True | False | False | int_employee_month | True |
| s101-T18 | 1 | True | False | False | fct_payroll_reconciliation | True |
| s101-T19 | 1 | True | False | False | stg_stage_events | True |
| s101-T20 | 1 | True | False | False | metric_headcount_monthly | True |
