-- S04: a terminal stage (hired, rejected, withdrawn, declined) is the last event of its application.
with ordered as (
    select
        application_id,
        stage,
        row_number() over (partition by application_id order by entered_at desc, event_id desc) as rn_desc
    from {{ ref('stg_stage_events') }}
)

select
    application_id,
    stage
from ordered
where stage in ('hired', 'rejected', 'withdrawn', 'declined')
    and rn_desc <> 1
