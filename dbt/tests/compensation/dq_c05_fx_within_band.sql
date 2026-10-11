-- C05: every rate is within 15% of its trailing 30-day median (current row and 29 preceding days).
with windowed as (
    select
        currency,
        rate_date,
        rate_to_usd,
        {{ trailing_median('rate_to_usd', 'currency', 'rate_date', 29) }} as trailing_window
    from {{ ref('stg_fx_rates') }}
),

medians as (
    select
        currency,
        rate_date,
        rate_to_usd,
        {{ trailing_median_finish('trailing_window') }} as trailing_median
    from windowed
)

select
    currency,
    rate_date,
    rate_to_usd,
    trailing_median
from medians
where abs(rate_to_usd - trailing_median) > 0.15 * trailing_median
