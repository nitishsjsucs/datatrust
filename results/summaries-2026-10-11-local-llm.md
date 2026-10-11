# Summary faithfulness eval, local-llm, 2026-10-11

- Command: `uv run datatrust bench summaries --provider local-llm --workers 4`
- Git commit: `615482823e454c6e8272fa229f3fcb49465db16c`
- Summarizer: Qwen3-1.7B Q4_0 via llama-server (local stand-in for Workers AI)
- Incidents: 20 (seed 101, every scenario, offline trials on DuckDB, the local stand-in for BigQuery)

| Metric | Value |
|---|---|
| First draft is a JSON object | 100% |
| First draft passes grounding | 10% |
| Accepted after one repair | 5% |
| Template fallback | 85% |
| Accepted drafts naming a top-3 root cause | 3/3 |
| PII leaks (names, emails, phones, birth dates, salaries) | 0 |

Grounding violations by rule, on the final attempt of each incident: unknown diagnostic SQL id (17), number outside a placeholder (14), unknown evidence ref (12), untokenized identifier (5), root cause not in top five (2), schema (1)

| Trial | Attempts | Grounded first | Repaired | Fallback | Root cause | In top 3 |
|---|---|---|---|---|---|---|
| s101-S01 | 2 | False | False | True | hires | True |
| s101-S02 | 2 | False | False | True | applications | True |
| s101-S03 | 2 | False | False | True | fx_rates | True |
| s101-S04 | 2 | False | False | True | stage_events | True |
| s101-S05 | 1 | True | False | False | job_assignments | True |
| s101-S06 | 2 | False | False | True | fx_rates | True |
| s101-S07 | 2 | False | False | True | fx_rates | True |
| s101-S08 | 2 | False | False | True | stage_events | True |
| s101-S09 | 1 | True | False | False | payroll_lines | True |
| s101-S10 | 2 | False | False | True | stg_compensation | True |
| s101-S11 | 2 | False | False | True | stg_payroll_lines | True |
| s101-S12 | 2 | False | False | True | hires | True |
| s101-S13 | 2 | False | False | True | compensation | True |
| s101-T14 | 2 | False | False | True | int_compensation_usd | True |
| s101-T15 | 2 | False | False | True | dim_employee | True |
| s101-T16 | 2 | False | True | False | stg_stage_events | True |
| s101-T17 | 2 | False | False | True | int_employee_month | True |
| s101-T18 | 2 | False | False | True | fct_payroll_reconciliation | True |
| s101-T19 | 2 | False | False | True | stg_stage_events | True |
| s101-T20 | 2 | False | False | True | metric_headcount_monthly | True |
