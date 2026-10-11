{#-
  ATS stage labels are mapped to canonical stage codes. The local date and hour of every event are
  derived in the requisition location's time zone through the dialect macros (SPEC 6.4, 7.3).
-#}
with events as (
    select * from {{ source('raw', 'stage_events') }}
),

applications as (
    select application_id, requisition_id from {{ source('raw', 'applications') }}
),

requisitions as (
    select requisition_id, location_id from {{ source('raw', 'requisitions') }}
),

locations as (
    select location_id, timezone from {{ source('raw', 'locations') }}
),

mapped as (
    select
        e.event_id,
        e.application_id,
        e.stage as stage_label,
        case e.stage
            when 'Applied' then 'applied'
            when 'Phone Screen' then 'screen'
            when 'Onsite Interview' then 'onsite'
            when 'Offer Extended' then 'offer'
            when 'Hired' then 'hired'
            when 'Rejected' then 'rejected'
            when 'Withdrawn' then 'withdrawn'
            when 'Offer Declined' then 'declined'
            else e.stage
        end as stage,
        e.entered_at,
        e.source_system,
        r.location_id,
        l.timezone as location_tz
    from events as e
    left join applications as a on e.application_id = a.application_id
    left join requisitions as r on a.requisition_id = r.requisition_id
    left join locations as l on r.location_id = l.location_id
)

select
    cast(event_id as {{ dt_type('int') }}) as event_id,
    cast(application_id as {{ dt_type('int') }}) as application_id,
    cast(stage_label as {{ dt_type('string') }}) as stage_label,
    cast(stage as {{ dt_type('string') }}) as stage,
    cast(
        case stage
            when 'applied' then 1
            when 'screen' then 2
            when 'onsite' then 3
            when 'offer' then 4
            when 'hired' then 5
            when 'rejected' then 5
            when 'withdrawn' then 5
            when 'declined' then 5
        end as {{ dt_type('int') }}
    ) as stage_order,
    entered_at,
    cast(source_system as {{ dt_type('string') }}) as source_system,
    cast(location_id as {{ dt_type('int') }}) as location_id,
    cast(location_tz as {{ dt_type('string') }}) as location_tz,
    {{ tz_local_date('entered_at', 'location_tz') }} as event_local_date,
    cast({{ tz_local_hour('entered_at', 'location_tz') }} as {{ dt_type('int') }}) as event_local_hour
from mapped
