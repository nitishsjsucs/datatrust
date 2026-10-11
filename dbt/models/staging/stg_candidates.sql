select
    cast(candidate_id as {{ dt_type('int') }}) as candidate_id,
    cast(first_name as {{ dt_type('string') }}) as first_name,
    cast(last_name as {{ dt_type('string') }}) as last_name,
    cast(email as {{ dt_type('string') }}) as email,
    cast(phone as {{ dt_type('string') }}) as phone,
    created_at
from {{ source('raw', 'candidates') }}
