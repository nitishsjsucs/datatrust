{#- Whole days from start_date to end_date (end - start). -#}
{% macro days_between(start_date, end_date) -%}
  {{ return(adapter.dispatch('days_between', 'datatrust')(start_date, end_date)) }}
{%- endmacro %}

{% macro default__days_between(start_date, end_date) -%}
  date_diff('day', {{ start_date }}, {{ end_date }})
{%- endmacro %}

{% macro duckdb__days_between(start_date, end_date) -%}
  date_diff('day', {{ start_date }}, {{ end_date }})
{%- endmacro %}

{% macro bigquery__days_between(start_date, end_date) -%}
  DATE_DIFF({{ end_date }}, {{ start_date }}, DAY)
{%- endmacro %}
