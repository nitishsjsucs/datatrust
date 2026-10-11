-- X03: the monthly payroll cost metric equals payroll lines converted at the rate on the 1st of the pay month,
-- recomputed here from staging independently of the marts (tolerance 0.01 USD).
with metric as (
    select
        pay_month,
        sum(payroll_cost_usd) as metric_usd
    from {{ ref('metric_payroll_cost_usd_monthly') }}
    group by pay_month
),

recomputed as (
    select
        p.pay_month,
        sum(cast(p.gross_pay_local_minor as {{ dt_type('money') }}) * 0.01 * f.rate_to_usd) as expected_usd
    from {{ ref('stg_payroll_lines') }} as p
    left join {{ ref('int_fx_daily') }} as f
        on f.currency = p.currency
        and f.rate_date = p.pay_month
    group by p.pay_month
)

select
    coalesce(m.pay_month, r.pay_month) as pay_month,
    m.metric_usd,
    r.expected_usd
from metric as m
full outer join recomputed as r
    on m.pay_month = r.pay_month
where m.metric_usd is null
    or r.expected_usd is null
    or abs(m.metric_usd - r.expected_usd) > 0.01
