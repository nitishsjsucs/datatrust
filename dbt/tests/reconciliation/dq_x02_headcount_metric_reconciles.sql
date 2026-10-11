-- X02: monthly headcount metric totals equal the active employees in int_employee_month.
with metric as (
    select
        month_start,
        sum(headcount) as metric_headcount
    from {{ ref('metric_headcount_monthly') }}
    group by month_start
),

base as (
    select
        month_start,
        sum(case when is_active then 1 else 0 end) as active_employees
    from {{ ref('int_employee_month') }}
    group by month_start
)

select
    coalesce(m.month_start, b.month_start) as month_start,
    m.metric_headcount,
    b.active_employees
from metric as m
full outer join base as b
    on m.month_start = b.month_start
where m.metric_headcount is null
    or b.active_employees is null
    or m.metric_headcount <> b.active_employees
