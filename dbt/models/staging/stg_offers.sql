select
    cast(offer_id as {{ dt_type('int') }}) as offer_id,
    cast(application_id as {{ dt_type('int') }}) as application_id,
    cast(offer_status as {{ dt_type('string') }}) as offer_status,
    offered_at,
    responded_at
from {{ source('raw', 'offers') }}
