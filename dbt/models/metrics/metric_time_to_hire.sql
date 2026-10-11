{#- Mean days from application (local date) to hire, by department x hire month. -#}
select
    department_id,
    hire_month,
    count(*) as hires,
    {{ dt_cast(safe_divide('cast(sum(days_to_hire) as ' ~ dt_type('money') ~ ')', 'count(*)'), 'money') }} as avg_days_to_hire
from {{ ref('fct_hires') }}
group by department_id, hire_month
