select
    cast(assignment_id as {{ dt_type('int') }}) as assignment_id,
    cast(employee_id as {{ dt_type('int') }}) as employee_id,
    cast(department_id as {{ dt_type('int') }}) as department_id,
    cast(location_id as {{ dt_type('int') }}) as location_id,
    cast(job_title as {{ dt_type('string') }}) as job_title,
    cast(job_level as {{ dt_type('int') }}) as job_level,
    valid_from,
    valid_to,
    valid_to is null as is_current
from {{ source('raw', 'job_assignments') }}
