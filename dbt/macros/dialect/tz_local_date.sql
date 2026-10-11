{#- Local calendar date of a zoned instant. Takes TIMESTAMPTZ (DuckDB) / TIMESTAMP (BigQuery) only (SPEC 7.3). -#}
{% macro tz_local_date(ts, tz) -%}
  {{ return(adapter.dispatch('tz_local_date', 'datatrust')(ts, tz)) }}
{%- endmacro %}

{% macro default__tz_local_date(ts, tz) -%}
  cast(timezone({{ tz }}, {{ ts }}) as date)
{%- endmacro %}

{% macro duckdb__tz_local_date(ts, tz) -%}
  cast(timezone({{ tz }}, {{ ts }}) as date)
{%- endmacro %}

{% macro bigquery__tz_local_date(ts, tz) -%}
  DATE({{ ts }}, {{ tz }})
{%- endmacro %}
