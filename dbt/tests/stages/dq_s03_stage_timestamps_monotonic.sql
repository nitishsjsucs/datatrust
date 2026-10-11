-- S03: in canonical stage order, stage timestamps never go backwards within an application.
with ordered as (
    select
        application_id,
        stage,
        stage_order,
        entered_at,
        lag(entered_at) over (partition by application_id order by stage_order, event_id) as prev_entered_at
    from {{ ref('stg_stage_events') }}
)

select
    application_id,
    stage,
    entered_at,
    prev_entered_at
from ordered
where prev_entered_at is not null
    and entered_at < prev_entered_at
