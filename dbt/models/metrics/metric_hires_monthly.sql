{#- Hires by department x month, bucketed by the local hire date (never a UTC date, SPEC 6.4). -#}
select
    department_id,
    hire_month,
    count(*) as hires
from {{ ref('fct_hires') }}
group by department_id, hire_month
