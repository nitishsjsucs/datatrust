{{ config(persist_docs={'relation': target.type == 'bigquery', 'columns': target.type == 'bigquery'}) }}

{#-
  Grain: one row per employee (1,200). The compensation interval active on
  as_of = least(2025-12-31, coalesce(termination_date, 2025-12-31)), with its USD value.
-#}
with employees as (
    select
        employee_id,
        least(date '{{ var("calendar_end") }}', coalesce(termination_date, date '{{ var("calendar_end") }}')) as as_of_date
    from {{ ref('stg_employees') }}
)

select
    e.employee_id,
    e.as_of_date,
    c.compensation_id,
    c.currency,
    {{ dt_cast('c.base_salary_local', 'money') }} as base_salary_local,
    c.fx_date,
    {{ dt_cast('c.rate_to_usd', 'rate') }} as rate_to_usd,
    {{ dt_cast('c.base_salary_usd', 'money') }} as base_salary_usd
from employees as e
inner join {{ ref('int_compensation_usd') }} as c
    on c.employee_id = e.employee_id
    and c.valid_from <= e.as_of_date
    and (c.valid_to is null or e.as_of_date < c.valid_to)
