select
    cast(requisition_id as {{ dt_type('int') }}) as requisition_id,
    cast(department_id as {{ dt_type('int') }}) as department_id,
    cast(location_id as {{ dt_type('int') }}) as location_id,
    cast(job_title as {{ dt_type('string') }}) as job_title,
    cast(openings as {{ dt_type('int') }}) as openings,
    opened_at
from {{ source('raw', 'requisitions') }}
