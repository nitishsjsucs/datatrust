-- X01: per employee-month, actual payroll gross is within 0.5% of the expected gross
-- (round half up of base / 12 on integer minor units, computed in the mart with int_div).
select
    employee_id,
    pay_month,
    expected_gross_local_minor,
    actual_gross_local_minor
from {{ ref('fct_payroll_reconciliation') }}
where expected_gross_local_minor is null
    or abs(actual_gross_local_minor - expected_gross_local_minor) > 0.005 * expected_gross_local_minor
