{{ config(persist_docs={'relation': target.type == 'bigquery', 'columns': target.type == 'bigquery'}) }}

{#- One row per employee with the assignment current on the as-of date (int_assignment_current). -#}
select
    e.employee_id,
    e.first_name,
    e.last_name,
    e.work_email,
    e.birth_date,
    e.hire_date,
    e.termination_date,
    e.termination_date is null as is_active,
    ac.as_of_date,
    ac.department_id,
    d.department_name,
    ac.location_id,
    l.location_name,
    l.location_tz,
    l.currency as location_currency,
    ac.job_title,
    ac.job_level
from {{ ref('stg_employees') }} as e
left join {{ ref('int_assignment_current') }} as ac
    on ac.employee_id = e.employee_id
left join {{ ref('stg_departments') }} as d
    on d.department_id = ac.department_id
left join {{ ref('stg_locations') }} as l
    on l.location_id = ac.location_id
