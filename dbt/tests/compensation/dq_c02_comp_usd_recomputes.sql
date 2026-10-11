-- C02: base_salary_usd in the mart recomputes, within 0.01 USD, from staging compensation and the daily FX
-- rate on the conversion date fx_date = least(greatest(valid_from, 2025-01-01), 2025-12-31). The conversion
-- is recomputed here independently of int_compensation_usd.
with recomputed as (
    select
        c.compensation_id,
        cast(c.base_salary_local_minor as {{ dt_type('money') }}) * 0.01 * f.rate_to_usd as expected_usd
    from {{ ref('stg_compensation') }} as c
    left join {{ ref('int_fx_daily') }} as f
        on f.currency = c.currency
        and f.rate_date = least(
            greatest(c.valid_from, date '{{ var("calendar_start") }}'),
            date '{{ var("calendar_end") }}'
        )
)

select
    m.employee_id,
    m.compensation_id,
    m.base_salary_usd,
    r.expected_usd
from {{ ref('fct_compensation_usd') }} as m
left join recomputed as r
    on r.compensation_id = m.compensation_id
where r.expected_usd is null
    or m.base_salary_usd is null
    or abs(m.base_salary_usd - r.expected_usd) > 0.01
