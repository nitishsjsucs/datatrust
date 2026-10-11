-- H07: no payroll line is posted for a month after the employee's termination month.
select
    p.payroll_line_id,
    p.employee_id,
    p.pay_month
from {{ ref('stg_payroll_lines') }} as p
inner join {{ ref('stg_employees') }} as e
    on e.employee_id = p.employee_id
where e.termination_date is not null
    and p.pay_month > {{ month_start('e.termination_date') }}
