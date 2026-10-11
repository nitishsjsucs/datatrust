{#-
  The raw integer minor-unit column passes through uncast, so a type drift in the source (for example
  salary delivered as text) fails this model's enforced contract (SPEC 7.2, scenario S13).
-#}
select
    cast(compensation_id as {{ dt_type('int') }}) as compensation_id,
    cast(employee_id as {{ dt_type('int') }}) as employee_id,
    cast(currency as {{ dt_type('string') }}) as currency,
    base_salary_local_minor,
    {{ dt_cast("cast(base_salary_local_minor as " ~ dt_type('money') ~ ") * 0.01", 'money') }} as base_salary_local,
    valid_from,
    valid_to
from {{ source('raw', 'compensation') }}
