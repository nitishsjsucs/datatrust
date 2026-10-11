select
    cast(payroll_line_id as {{ dt_type('int') }}) as payroll_line_id,
    cast(employee_id as {{ dt_type('int') }}) as employee_id,
    pay_month,
    cast(currency as {{ dt_type('string') }}) as currency,
    gross_pay_local_minor,
    {{ dt_cast("cast(gross_pay_local_minor as " ~ dt_type('money') ~ ") * 0.01", 'money') }} as gross_pay_local,
    paid_at
from {{ source('raw', 'payroll_lines') }}
