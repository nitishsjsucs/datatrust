-- X04: three-way reconciliation per month: hires metric = fct_hires rows = HRIS hired events.
-- Every side buckets by the LOCAL hire date; a UTC bucket would move 1st-of-month hires east of UTC
-- into the previous month (SPEC 6.4).
with metric as (
    select
        hire_month as month_start,
        sum(hires) as metric_hires
    from {{ ref('metric_hires_monthly') }}
    group by hire_month
),

facts as (
    select
        hire_month as month_start,
        count(*) as fact_hires
    from {{ ref('fct_hires') }}
    group by hire_month
),

events as (
    select
        {{ month_start('event_local_date') }} as month_start,
        count(*) as hired_events
    from {{ ref('stg_stage_events') }}
    where stage = 'hired'
    group by {{ month_start('event_local_date') }}
)

select
    coalesce(m.month_start, f.month_start, e.month_start) as month_start,
    m.metric_hires,
    f.fact_hires,
    e.hired_events
from metric as m
full outer join facts as f
    on f.month_start = m.month_start
full outer join events as e
    on e.month_start = coalesce(m.month_start, f.month_start)
where coalesce(m.metric_hires, -1) <> coalesce(f.fact_hires, -1)
    or coalesce(f.fact_hires, -1) <> coalesce(e.hired_events, -1)
