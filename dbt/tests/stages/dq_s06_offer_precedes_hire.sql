-- S06: the offer stage's local date is on or before the hire date.
select
    h.hire_id,
    h.application_id,
    h.hire_date,
    e.event_local_date as offer_local_date
from {{ ref('stg_hires') }} as h
inner join {{ ref('stg_stage_events') }} as e
    on e.application_id = h.application_id
    and e.stage = 'offer'
where e.event_local_date > h.hire_date
