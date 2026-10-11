-- H01: no two job assignment intervals of one employee overlap (half-open [valid_from, valid_to)).
select
    a.employee_id,
    a.assignment_id,
    b.assignment_id as other_assignment_id
from {{ ref('stg_job_assignments') }} as a
inner join {{ ref('stg_job_assignments') }} as b
    on a.employee_id = b.employee_id
    and a.assignment_id < b.assignment_id
    and a.valid_from < coalesce(b.valid_to, date '9999-12-31')
    and b.valid_from < coalesce(a.valid_to, date '9999-12-31')
