{#- Daily rate per currency on the 2025 calendar. Gaps are not filled here: C04 must see them. -#}
select
    currency,
    rate_date,
    {{ dt_cast('rate_to_usd', 'rate') }} as rate_to_usd
from {{ ref('stg_fx_rates') }}
where rate_date between date '{{ var("calendar_start") }}' and date '{{ var("calendar_end") }}'
