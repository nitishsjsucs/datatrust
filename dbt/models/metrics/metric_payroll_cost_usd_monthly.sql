{{ config(persist_docs={'relation': target.type == 'bigquery', 'columns': target.type == 'bigquery'}) }}

{#-
  Payroll cost in USD by department x pay month (rate on the 1st of the pay month). payroll_cost_usd carries
  the compensation policy tag (masked to NULL for the analyst): unlike int_comp_by_dept_month there is no
  k >= 5 suppression, so a small department-month would expose individual pay.
-#}
select
    department_id,
    pay_month,
    count(*) as employees_paid,
    {{ dt_cast('sum(actual_gross_usd)', 'money') }} as payroll_cost_usd
from {{ ref('fct_payroll_reconciliation') }}
group by department_id, pay_month
