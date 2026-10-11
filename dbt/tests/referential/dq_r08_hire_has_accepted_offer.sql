-- R08: every hire has an accepted offer on the same application.
select
    h.hire_id,
    h.application_id
from {{ ref('stg_hires') }} as h
left join {{ ref('stg_offers') }} as o
    on o.application_id = h.application_id
    and o.offer_status = 'accepted'
where o.offer_id is null
