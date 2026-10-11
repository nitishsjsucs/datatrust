select
    cast(location_id as {{ dt_type('int') }}) as location_id,
    cast(location_name as {{ dt_type('string') }}) as location_name,
    cast(country_code as {{ dt_type('string') }}) as country_code,
    cast(timezone as {{ dt_type('string') }}) as location_tz,
    cast(currency as {{ dt_type('string') }}) as currency
from {{ source('raw', 'locations') }}
