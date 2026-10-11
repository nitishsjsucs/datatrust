{#- Integer floor division on non-negative integers; used for round-half-up gross pay (SPEC 6.5). -#}
{% macro int_div(a, b) -%}
  {{ return(adapter.dispatch('int_div', 'datatrust')(a, b)) }}
{%- endmacro %}

{% macro default__int_div(a, b) -%}
  ({{ a }}) // ({{ b }})
{%- endmacro %}

{% macro duckdb__int_div(a, b) -%}
  ({{ a }}) // ({{ b }})
{%- endmacro %}

{% macro bigquery__int_div(a, b) -%}
  DIV({{ a }}, {{ b }})
{%- endmacro %}
