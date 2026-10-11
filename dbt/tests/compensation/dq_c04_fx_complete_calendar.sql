-- C04: every currency in use has a rate for every day of the 2025 calendar.
with currencies as (
    select distinct currency from {{ ref('stg_locations') }}
),

calendar as (
    select d as rate_date
    from {{ date_spine("date '" ~ var('calendar_start') ~ "'", "date '" ~ var('calendar_end') ~ "'") }} as spine
)

select
    c.currency,
    k.rate_date
from currencies as c
cross join calendar as k
left join {{ ref('stg_fx_rates') }} as f
    on f.currency = c.currency
    and f.rate_date = k.rate_date
where f.rate_date is null
