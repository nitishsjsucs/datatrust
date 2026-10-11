-- C06: the current compensation currency equals the currency of the current assignment's location.
select
    f.employee_id,
    f.currency,
    ac.location_currency
from {{ ref('fct_compensation_usd') }} as f
inner join {{ ref('int_assignment_current') }} as ac
    on ac.employee_id = f.employee_id
where ac.location_currency is null
    or f.currency <> ac.location_currency
