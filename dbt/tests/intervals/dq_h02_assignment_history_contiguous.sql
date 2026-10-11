-- H02: assignment history is contiguous from hire to termination: each interval ends where the next one
-- starts, the last one is open for active employees and ends the day after termination for leavers.
with ordered as (
    select
        employee_id,
        assignment_id,
        valid_from,
        valid_to,
        lead(valid_from) over (partition by employee_id order by valid_from, assignment_id) as next_valid_from
    from {{ ref('stg_job_assignments') }}
)

select
    o.employee_id,
    o.assignment_id,
    o.valid_from,
    o.valid_to,
    o.next_valid_from
from ordered as o
inner join {{ ref('stg_employees') }} as e
    on e.employee_id = o.employee_id
where (o.next_valid_from is not null and (o.valid_to is null or o.valid_to <> o.next_valid_from))
    or (o.next_valid_from is null and e.termination_date is null and o.valid_to is not null)
    or (
        o.next_valid_from is null
        and e.termination_date is not null
        and (o.valid_to is null or o.valid_to <> {{ add_days('e.termination_date', 1) }})
    )
