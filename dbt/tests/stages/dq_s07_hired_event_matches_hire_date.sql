-- S07: the hired event's local date (requisition location zone) equals the HRIS hire date.
select
    h.hire_id,
    h.application_id,
    h.hire_date,
    e.event_local_date
from {{ ref('stg_hires') }} as h
left join {{ ref('stg_stage_events') }} as e
    on e.application_id = h.application_id
    and e.stage = 'hired'
where e.event_id is null
    or e.event_local_date <> h.hire_date
