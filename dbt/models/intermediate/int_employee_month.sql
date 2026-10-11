{#-
  Employee x month of 2025 (1,200 x 12 rows) with an active flag and the assignment and compensation
  intervals in effect on the 1st of the month (half-open [valid_from, valid_to)).
-#}
with months as (
    select d as month_start
    from {{ date_spine("date '" ~ var('calendar_start') ~ "'", "date '" ~ var('calendar_end') ~ "'") }} as spine
    where extract(day from d) = 1
),

employee_months as (
    select
        e.employee_id,
        m.month_start,
        e.hire_date,
        e.termination_date,
        (
            e.hire_date <= m.month_start
            and (e.termination_date is null or e.termination_date >= m.month_start)
        ) as is_active
    from {{ ref('stg_employees') }} as e
    cross join months as m
)

select
    em.employee_id,
    em.month_start,
    em.hire_date,
    em.termination_date,
    em.is_active,
    a.department_id,
    a.location_id,
    c.compensation_id,
    c.currency,
    c.base_salary_local_minor,
    c.base_salary_local
from employee_months as em
left join {{ ref('stg_job_assignments') }} as a
    on a.employee_id = em.employee_id
    and a.valid_from <= em.month_start
    and (a.valid_to is null or em.month_start < a.valid_to)
left join {{ ref('stg_compensation') }} as c
    on c.employee_id = em.employee_id
    and c.valid_from <= em.month_start
    and (c.valid_to is null or em.month_start < c.valid_to)
