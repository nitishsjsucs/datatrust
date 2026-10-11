{#- One DATE column `d` for every day in [start_date, end_date] (SPEC 7.3). Use as a subquery: from {{ date_spine(...) }} as s -#}
{% macro date_spine(start_date, end_date) -%}
  {{ return(adapter.dispatch('date_spine', 'datatrust')(start_date, end_date)) }}
{%- endmacro %}

{% macro default__date_spine(start_date, end_date) -%}
  {{ return(duckdb__date_spine(start_date, end_date)) }}
{%- endmacro %}

{#- range() over dates returns TIMESTAMP in DuckDB, hence the cast. -#}
{% macro duckdb__date_spine(start_date, end_date) -%}
  (select cast(unnest(range({{ start_date }}, {{ end_date }} + 1, interval 1 day)) as date) as d)
{%- endmacro %}

{% macro bigquery__date_spine(start_date, end_date) -%}
  (select d from UNNEST(GENERATE_DATE_ARRAY({{ start_date }}, {{ end_date }})) as d)
{%- endmacro %}
