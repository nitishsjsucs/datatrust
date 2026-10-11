{#-
  Read a relation as of an earlier point (SPEC 7.3, 10).
  BigQuery: FOR SYSTEM_TIME AS OF a constant TIMESTAMP_MILLIS literal (tables only, at most 7 days back,
  one point in time per table per statement).
  DuckDB stand-in: the Parquet snapshot written for a green run, under the absolute snapshot_dir var.
  `as_of` is epoch milliseconds on BigQuery and the snapshot run id on DuckDB.
-#}
{% macro time_travel(relation, as_of, node_name) -%}
  {{ return(adapter.dispatch('time_travel', 'datatrust')(relation, as_of, node_name)) }}
{%- endmacro %}

{% macro default__time_travel(relation, as_of, node_name) -%}
  {{ return(duckdb__time_travel(relation, as_of, node_name)) }}
{%- endmacro %}

{% macro duckdb__time_travel(relation, as_of, node_name) -%}
  read_parquet('{{ var("snapshot_dir") }}/{{ as_of }}/{{ node_name }}.parquet')
{%- endmacro %}

{% macro bigquery__time_travel(relation, as_of, node_name) -%}
  {{ relation }} FOR SYSTEM_TIME AS OF TIMESTAMP_MILLIS({{ as_of }})
{%- endmacro %}
