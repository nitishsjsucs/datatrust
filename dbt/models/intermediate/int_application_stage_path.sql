{#- One row per application: ordered stage path as text plus the key stage instants. -#}
select
    application_id,
    {{ ordered_path('stage', 'entered_at, stage_order') }} as stage_path,
    count(*) as n_events,
    min(case when stage = 'applied' then entered_at end) as applied_at,
    min(case when stage = 'screen' then entered_at end) as screen_at,
    min(case when stage = 'onsite' then entered_at end) as onsite_at,
    min(case when stage = 'offer' then entered_at end) as offer_at,
    min(case when stage = 'hired' then entered_at end) as hired_at,
    min(case when stage = 'applied' then event_local_date end) as applied_local_date,
    min(case when stage = 'offer' then event_local_date end) as offer_local_date,
    min(case when stage = 'hired' then event_local_date end) as hired_local_date,
    max(case when stage in ('hired', 'rejected', 'withdrawn', 'declined') then stage end) as terminal_stage
from {{ ref('stg_stage_events') }}
group by application_id
