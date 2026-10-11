{{ config(persist_docs={'relation': target.type == 'bigquery', 'columns': target.type == 'bigquery'}) }}

{#- One row per hire. hire_date is the local hire date; hire_month buckets by it, never by UTC (SPEC 6.4). -#}
select
    h.hire_id,
    h.application_id,
    h.employee_id,
    a.candidate_id,
    a.requisition_id,
    r.department_id,
    r.location_id,
    h.hire_date,
    {{ month_start('h.hire_date') }} as hire_month,
    p.applied_local_date,
    p.offer_local_date,
    o.offered_at,
    o.responded_at as offer_accepted_at,
    {{ days_between('p.applied_local_date', 'h.hire_date') }} as days_to_hire
from {{ ref('stg_hires') }} as h
left join {{ ref('stg_applications') }} as a
    on a.application_id = h.application_id
left join {{ ref('stg_requisitions') }} as r
    on r.requisition_id = a.requisition_id
left join {{ ref('int_application_stage_path') }} as p
    on p.application_id = h.application_id
left join {{ ref('stg_offers') }} as o
    on o.application_id = h.application_id
    and o.offer_status = 'accepted'
