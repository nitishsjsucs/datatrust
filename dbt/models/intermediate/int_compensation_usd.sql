{#-
  One row per compensation interval (1,980 on clean data). FX covers 2025 only, so every interval converts
  at an explicit date inside the calendar: fx_date = least(greatest(valid_from, 2025-01-01), 2025-12-31).
-#}
with compensation as (
    select
        compensation_id,
        employee_id,
        currency,
        base_salary_local_minor,
        base_salary_local,
        valid_from,
        valid_to,
        least(
            greatest(valid_from, date '{{ var("calendar_start") }}'),
            date '{{ var("calendar_end") }}'
        ) as fx_date
    from {{ ref('stg_compensation') }}
)

select
    c.compensation_id,
    c.employee_id,
    c.currency,
    c.base_salary_local_minor,
    c.base_salary_local,
    c.valid_from,
    c.valid_to,
    c.fx_date,
    f.rate_to_usd,
    {{ dt_cast('c.base_salary_local * f.rate_to_usd', 'money') }} as base_salary_usd
from compensation as c
left join {{ ref('int_fx_daily') }} as f
    on f.currency = c.currency
    and f.rate_date = c.fx_date
