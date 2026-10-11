{#-
  Department x month compensation aggregates with no per-person rows. Groups under 5 employees are
  suppressed. Untagged on purpose: the authorized view rpt_compensation_by_dept reads only this table
  (SPEC 7.4), because an authorized view does not bypass column-level security on tagged columns.
-#}
with active as (
    select
        em.department_id,
        em.month_start,
        em.employee_id,
        {{ dt_cast('em.base_salary_local * f.rate_to_usd', 'money') }} as base_salary_usd
    from {{ ref('int_employee_month') }} as em
    left join {{ ref('int_fx_daily') }} as f
        on f.currency = em.currency
        and f.rate_date = em.month_start
    where em.is_active
)

select
    department_id,
    month_start,
    count(distinct employee_id) as headcount,
    {{ dt_cast('sum(base_salary_usd)', 'money') }} as total_base_salary_usd,
    {{ dt_cast(safe_divide('sum(base_salary_usd)', 'count(distinct employee_id)'), 'money') }} as avg_base_salary_usd
from active
group by department_id, month_start
having count(distinct employee_id) >= 5
