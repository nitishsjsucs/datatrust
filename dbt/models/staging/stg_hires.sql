select
    cast(hire_id as {{ dt_type('int') }}) as hire_id,
    cast(application_id as {{ dt_type('int') }}) as application_id,
    cast(employee_id as {{ dt_type('int') }}) as employee_id,
    hire_date
from {{ source('raw', 'hires') }}
