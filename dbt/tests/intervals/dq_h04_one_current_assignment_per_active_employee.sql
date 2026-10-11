-- H04: every active employee has exactly one open (current) assignment.
select
    e.employee_id,
    count(a.assignment_id) as n_current
from {{ ref('stg_employees') }} as e
left join {{ ref('stg_job_assignments') }} as a
    on a.employee_id = e.employee_id
    and a.valid_to is null
where e.termination_date is null
group by e.employee_id
having count(a.assignment_id) <> 1
