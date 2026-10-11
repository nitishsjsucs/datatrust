{#- DATE plus n days, as a DATE (DuckDB date + interval yields a TIMESTAMP, so integer addition is used). -#}
{% macro add_days(d, n) -%}
  {{ return(adapter.dispatch('add_days', 'datatrust')(d, n)) }}
{%- endmacro %}

{% macro default__add_days(d, n) -%}
  ({{ d }} + {{ n }})
{%- endmacro %}

{% macro duckdb__add_days(d, n) -%}
  ({{ d }} + {{ n }})
{%- endmacro %}

{% macro bigquery__add_days(d, n) -%}
  DATE_ADD({{ d }}, INTERVAL {{ n }} DAY)
{%- endmacro %}
