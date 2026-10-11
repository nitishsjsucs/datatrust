{#- First day of the month of a DATE, as a DATE. -#}
{% macro month_start(d) -%}
  {{ return(adapter.dispatch('month_start', 'datatrust')(d)) }}
{%- endmacro %}

{% macro default__month_start(d) -%}
  cast(date_trunc('month', {{ d }}) as date)
{%- endmacro %}

{% macro duckdb__month_start(d) -%}
  cast(date_trunc('month', {{ d }}) as date)
{%- endmacro %}

{% macro bigquery__month_start(d) -%}
  DATE_TRUNC({{ d }}, MONTH)
{%- endmacro %}
