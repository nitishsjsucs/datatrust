select
    cast(application_id as {{ dt_type('int') }}) as application_id,
    cast(candidate_id as {{ dt_type('int') }}) as candidate_id,
    cast(requisition_id as {{ dt_type('int') }}) as requisition_id,
    cast(source_channel as {{ dt_type('string') }}) as source_channel,
    applied_at
from {{ source('raw', 'applications') }}
