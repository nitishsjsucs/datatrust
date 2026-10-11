{#- Active headcount by department x month: hired on or before the 1st and not terminated before it. -#}
select
    department_id,
    month_start,
    count(*) as headcount
from {{ ref('int_employee_month') }}
where hire_date <= month_start
    and (termination_date is null or termination_date >= month_start)
group by department_id, month_start
