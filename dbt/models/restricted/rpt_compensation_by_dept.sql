{{
    config(
        grant_access_to=([{'project': target.project, 'dataset': 'datatrust_staging'}] if target.type == 'bigquery' else none)
    )
}}

{#-
  Restricted report: department x month compensation aggregates only. Reads the untagged aggregate
  int_comp_by_dept_month (k >= 5 suppression applied there) and exposes no per-person columns. On BigQuery
  this view is authorized on the staging dataset (SPEC 7.4); on DuckDB it is a plain view (stand-in).
-#}
select
    department_id,
    month_start,
    headcount,
    total_base_salary_usd,
    avg_base_salary_usd
from {{ ref('int_comp_by_dept_month') }}
