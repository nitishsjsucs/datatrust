-- S02: consecutive stages of an application (in time order) are an allowed transition.
with ordered as (
    select
        application_id,
        stage,
        lead(stage) over (partition by application_id order by entered_at, event_id) as next_stage
    from {{ ref('stg_stage_events') }}
)

select
    application_id,
    stage,
    next_stage
from ordered
where next_stage is not null
    and concat(stage, '>', next_stage) not in (
        'applied>screen', 'applied>rejected', 'applied>withdrawn',
        'screen>onsite', 'screen>rejected', 'screen>withdrawn',
        'onsite>offer', 'onsite>rejected', 'onsite>withdrawn',
        'offer>hired', 'offer>declined', 'offer>withdrawn'
    )
