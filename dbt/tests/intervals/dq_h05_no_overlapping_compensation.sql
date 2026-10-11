-- H05: no two compensation intervals of one employee overlap.
select
    a.employee_id,
    a.compensation_id,
    b.compensation_id as other_compensation_id
from {{ ref('stg_compensation') }} as a
inner join {{ ref('stg_compensation') }} as b
    on a.employee_id = b.employee_id
    and a.compensation_id < b.compensation_id
    and a.valid_from < coalesce(b.valid_to, date '9999-12-31')
    and b.valid_from < coalesce(a.valid_to, date '9999-12-31')
