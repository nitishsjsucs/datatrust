{{ config(persist_docs={'relation': target.type == 'bigquery', 'columns': target.type == 'bigquery'}) }}

{#- One row per application with funnel flags and the outcome. -#}
select
    a.application_id,
    a.candidate_id,
    a.requisition_id,
    r.department_id,
    r.location_id,
    a.source_channel,
    p.stage_path,
    p.applied_at,
    p.screen_at is not null as reached_screen,
    p.onsite_at is not null as reached_onsite,
    p.offer_at is not null as reached_offer,
    p.hired_at is not null as was_hired,
    coalesce(p.terminal_stage, 'open') as outcome
from {{ ref('stg_applications') }} as a
left join {{ ref('stg_requisitions') }} as r
    on r.requisition_id = a.requisition_id
left join {{ ref('int_application_stage_path') }} as p
    on p.application_id = a.application_id
