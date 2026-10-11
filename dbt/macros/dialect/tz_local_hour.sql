{#- Local wall-clock hour (0-23) of a zoned instant (SPEC 7.3). -#}
{% macro tz_local_hour(ts, tz) -%}
  {{ return(adapter.dispatch('tz_local_hour', 'datatrust')(ts, tz)) }}
{%- endmacro %}

{% macro default__tz_local_hour(ts, tz) -%}
  extract(hour from timezone({{ tz }}, {{ ts }}))
{%- endmacro %}

{% macro duckdb__tz_local_hour(ts, tz) -%}
  extract(hour from timezone({{ tz }}, {{ ts }}))
{%- endmacro %}

{% macro bigquery__tz_local_hour(ts, tz) -%}
  EXTRACT(HOUR FROM {{ ts }} AT TIME ZONE {{ tz }})
{%- endmacro %}
