{#- Rows whose combination of columns is not unique (no dbt packages are used, SPEC 8). -#}
{% test unique_combination(model, combination_of_columns) %}
select
    {{ combination_of_columns | join(', ') }},
    count(*) as n_rows
from {{ model }}
group by {{ combination_of_columns | join(', ') }}
having count(*) > 1
{% endtest %}
