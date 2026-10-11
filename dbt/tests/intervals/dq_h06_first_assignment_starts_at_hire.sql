-- H06: the first assignment of every employee starts on the hire date.
with first_assignment as (
    select
        employee_id,
        min(valid_from) as first_valid_from
    from {{ ref('stg_job_assignments') }}
    group by employee_id
)

select
    e.employee_id,
    e.hire_date,
    f.first_valid_from
from {{ ref('stg_employees') }} as e
left join first_assignment as f
    on f.employee_id = e.employee_id
where f.first_valid_from is null
    or f.first_valid_from <> e.hire_date
