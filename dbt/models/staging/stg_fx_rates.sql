select
    cast(currency as {{ dt_type('string') }}) as currency,
    rate_date,
    {{ dt_cast('rate_to_usd', 'rate') }} as rate_to_usd
from {{ source('raw', 'fx_rates') }}
