{#- Rows where the boolean expression is false. NULL counts as a failure, so a missing value never passes. -#}
{% test expression_is_true(model, expression) %}
select *
from {{ model }}
where not coalesce(({{ expression }}), false)
{% endtest %}
