{#- Payroll cost in USD by department x pay month (rate on the 1st of the pay month). -#}
select
    department_id,
    pay_month,
    count(*) as employees_paid,
    {{ dt_cast('sum(actual_gross_usd)', 'money') }} as payroll_cost_usd
from {{ ref('fct_payroll_reconciliation') }}
group by department_id, pay_month
