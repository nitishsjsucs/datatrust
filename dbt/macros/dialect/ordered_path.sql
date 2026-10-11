{#- Stage path as text, e.g. applied>screen>rejected. Same syntax in both dialects; text, not arrays,
    because BigQuery arrays are not comparable with = (SPEC 7.3). -#}
{% macro ordered_path(col, ord) -%}
  {{ return(adapter.dispatch('ordered_path', 'datatrust')(col, ord)) }}
{%- endmacro %}

{% macro default__ordered_path(col, ord) -%}
  string_agg({{ col }}, '>' order by {{ ord }})
{%- endmacro %}

{% macro duckdb__ordered_path(col, ord) -%}
  string_agg({{ col }}, '>' order by {{ ord }})
{%- endmacro %}

{% macro bigquery__ordered_path(col, ord) -%}
  STRING_AGG({{ col }}, '>' ORDER BY {{ ord }})
{%- endmacro %}
