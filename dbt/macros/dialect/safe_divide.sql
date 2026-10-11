{% macro safe_divide(a, b) -%}
  {{ return(adapter.dispatch('safe_divide', 'datatrust')(a, b)) }}
{%- endmacro %}

{% macro default__safe_divide(a, b) -%}
  case when ({{ b }}) = 0 then null else ({{ a }}) / ({{ b }}) end
{%- endmacro %}

{% macro duckdb__safe_divide(a, b) -%}
  case when ({{ b }}) = 0 then null else ({{ a }}) / ({{ b }}) end
{%- endmacro %}

{% macro bigquery__safe_divide(a, b) -%}
  SAFE_DIVIDE({{ a }}, {{ b }})
{%- endmacro %}
