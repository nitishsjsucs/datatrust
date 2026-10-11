-- S05: per location, at least 98% of recruiter_tool events fall between 07:00 and 21:00 local time.
-- The local hour is recomputed here from the instant and the zone (tz_local_hour), not read from staging.
with events as (
    select
        location_id,
        {{ tz_local_hour('entered_at', 'location_tz') }} as local_hour
    from {{ ref('stg_stage_events') }}
    where source_system = 'recruiter_tool'
)

select
    location_id,
    count(*) as n_events,
    sum(case when local_hour >= 7 and local_hour < 21 then 1 else 0 end) as n_in_hours
from events
group by location_id
having sum(case when local_hour >= 7 and local_hour < 21 then 1 else 0 end) < 0.98 * count(*)
