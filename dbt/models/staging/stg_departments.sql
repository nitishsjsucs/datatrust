select
    cast(department_id as {{ dt_type('int') }}) as department_id,
    cast(department_name as {{ dt_type('string') }}) as department_name,
    cast(cost_center as {{ dt_type('string') }}) as cost_center
from {{ source('raw', 'departments') }}
