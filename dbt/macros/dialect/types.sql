{#-
  Adapter-specific types (SPEC 7.2, ADR-0006). Money and rates are decimal(38,9) on DuckDB
  (plain `numeric` there is DECIMAL(18,3) and is banned) and NUMERIC (38,9) on BigQuery.
-#}
{% macro dt_type(kind) -%}
  {{ return(adapter.dispatch('dt_type', 'datatrust')(kind)) }}
{%- endmacro %}

{% macro default__dt_type(kind) -%}
  {{ return(duckdb__dt_type(kind)) }}
{%- endmacro %}

{% macro duckdb__dt_type(kind) -%}
  {%- set types = {
      'money': 'decimal(38,9)',
      'rate': 'decimal(38,9)',
      'int': 'bigint',
      'string': 'varchar',
      'ts': 'timestamptz',
      'date': 'date',
      'bool': 'boolean',
      'float': 'double',
  } -%}
  {{ return(types[kind]) }}
{%- endmacro %}

{% macro bigquery__dt_type(kind) -%}
  {%- set types = {
      'money': 'numeric',
      'rate': 'numeric',
      'int': 'int64',
      'string': 'string',
      'ts': 'timestamp',
      'date': 'date',
      'bool': 'bool',
      'float': 'float64',
  } -%}
  {{ return(types[kind]) }}
{%- endmacro %}

{#- Wrap every money and rate output: DuckDB decimal division yields DOUBLE and multiplication widens the scale. -#}
{% macro dt_cast(expr, kind) -%}
  cast({{ expr }} as {{ dt_type(kind) }})
{%- endmacro %}
