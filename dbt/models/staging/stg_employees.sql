select
    cast(employee_id as {{ dt_type('int') }}) as employee_id,
    cast(first_name as {{ dt_type('string') }}) as first_name,
    cast(last_name as {{ dt_type('string') }}) as last_name,
    cast(work_email as {{ dt_type('string') }}) as work_email,
    birth_date,
    hire_date,
    termination_date
from {{ source('raw', 'employees') }}
