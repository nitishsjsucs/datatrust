{#- Layers map to DuckDB schemas raw/staging/marts/restricted and to BigQuery datasets datatrust_<layer> (SPEC 7.4). -#}
{% macro generate_schema_name(custom_schema_name, node) -%}
  {%- if custom_schema_name is none -%}
    {{ target.schema }}
  {%- elif target.type == 'bigquery' -%}
    datatrust_{{ custom_schema_name | trim }}
  {%- else -%}
    {{ custom_schema_name | trim }}
  {%- endif -%}
{%- endmacro %}
