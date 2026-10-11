{#- The assignment active on each employee's as-of date: 2025-12-31, or the termination date for leavers. -#}
with employees as (
    select
        employee_id,
        least(date '{{ var("calendar_end") }}', coalesce(termination_date, date '{{ var("calendar_end") }}')) as as_of_date
    from {{ ref('stg_employees') }}
)

select
    e.employee_id,
    e.as_of_date,
    a.assignment_id,
    a.department_id,
    a.location_id,
    a.job_title,
    a.job_level,
    a.valid_from,
    a.valid_to,
    l.location_tz,
    l.currency as location_currency
from employees as e
inner join {{ ref('stg_job_assignments') }} as a
    on a.employee_id = e.employee_id
    and a.valid_from <= e.as_of_date
    and (a.valid_to is null or e.as_of_date < a.valid_to)
left join {{ ref('stg_locations') }} as l
    on a.location_id = l.location_id
