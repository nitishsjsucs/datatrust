{{ config(persist_docs={'relation': target.type == 'bigquery', 'columns': target.type == 'bigquery'}) }}

{#-
  Employee x active month: actual gross from payroll lines vs expected gross from the compensation interval
  in effect on the 1st, expected = round_half_up(base / 12) = int_div(base + 6, 12) on integer minor units
  (SPEC 6.5). USD at the rate on the 1st of the pay month.
-#}
with actual as (
    select
        employee_id,
        pay_month,
        count(*) as n_lines,
        cast(sum(gross_pay_local_minor) as {{ dt_type('int') }}) as actual_gross_local_minor
    from {{ ref('stg_payroll_lines') }}
    group by employee_id, pay_month
),

expected as (
    select
        employee_id,
        month_start as pay_month,
        department_id,
        currency,
        base_salary_local_minor,
        {{ int_div('base_salary_local_minor + 6', 12) }} as expected_gross_local_minor
    from {{ ref('int_employee_month') }}
    where is_active
)

select
    x.employee_id,
    x.pay_month,
    x.department_id,
    x.currency,
    x.base_salary_local_minor,
    x.expected_gross_local_minor,
    coalesce(a.actual_gross_local_minor, 0) as actual_gross_local_minor,
    coalesce(a.n_lines, 0) as n_lines,
    {{ dt_cast("cast(x.expected_gross_local_minor as " ~ dt_type('money') ~ ") * 0.01", 'money') }} as expected_gross_local,
    {{ dt_cast("cast(coalesce(a.actual_gross_local_minor, 0) as " ~ dt_type('money') ~ ") * 0.01", 'money') }} as actual_gross_local,
    {{ dt_cast(safe_divide(
        "cast(coalesce(a.actual_gross_local_minor, 0) - x.expected_gross_local_minor as " ~ dt_type('money') ~ ")",
        "cast(x.expected_gross_local_minor as " ~ dt_type('money') ~ ")"
    ), 'rate') }} as delta_pct,
    {{ dt_cast('f.rate_to_usd', 'rate') }} as rate_to_usd,
    {{ dt_cast("cast(coalesce(a.actual_gross_local_minor, 0) as " ~ dt_type('money') ~ ") * 0.01 * f.rate_to_usd", 'money') }} as actual_gross_usd
from expected as x
left join actual as a
    on a.employee_id = x.employee_id
    and a.pay_month = x.pay_month
left join {{ ref('int_fx_daily') }} as f
    on f.currency = x.currency
    and f.rate_date = x.pay_month
