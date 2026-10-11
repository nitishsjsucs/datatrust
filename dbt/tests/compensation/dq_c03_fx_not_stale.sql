-- C03: no non-USD currency repeats the same rate on more than 3 consecutive days (a stale feed).
with flagged as (
    select
        currency,
        rate_date,
        rate_to_usd,
        case
            when rate_to_usd = lag(rate_to_usd) over (partition by currency order by rate_date) then 0
            else 1
        end as starts_run
    from {{ ref('stg_fx_rates') }}
    where currency <> 'USD'
),

runs as (
    select
        currency,
        rate_date,
        sum(starts_run) over (
            partition by currency order by rate_date rows between unbounded preceding and current row
        ) as run_id
    from flagged
)

select
    currency,
    run_id,
    min(rate_date) as run_start,
    count(*) as run_days
from runs
group by currency, run_id
having count(*) > 3
