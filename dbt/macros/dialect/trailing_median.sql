{#-
  Exact trailing median over the current row and the n preceding rows (SPEC 7.3).

  BigQuery PERCENTILE_CONT/DISC accept only PARTITION BY in OVER (no ORDER BY, no frame), so the median
  is computed in two steps that both dialects share:
    step 1, in a CTE:       {{ trailing_median('x', 'part', 'ord', 29) }} as trailing_window
    step 2, in the next one: {{ trailing_median_finish('trailing_window') }} as trailing_median
  DuckDB computes the windowed median in step 1 and step 2 is the identity. BigQuery collects the window
  into an array in step 1 and takes the exact median (average of the middle one or two values) in step 2.
-#}
{% macro trailing_median(x, part, ord, n) -%}
  {{ return(adapter.dispatch('trailing_median', 'datatrust')(x, part, ord, n)) }}
{%- endmacro %}

{% macro default__trailing_median(x, part, ord, n) -%}
  {{ return(duckdb__trailing_median(x, part, ord, n)) }}
{%- endmacro %}

{% macro duckdb__trailing_median(x, part, ord, n) -%}
  median({{ x }}) over (partition by {{ part }} order by {{ ord }} rows between {{ n }} preceding and current row)
{%- endmacro %}

{% macro bigquery__trailing_median(x, part, ord, n) -%}
  ARRAY_AGG({{ x }} IGNORE NULLS) OVER (PARTITION BY {{ part }} ORDER BY {{ ord }} ROWS BETWEEN {{ n }} PRECEDING AND CURRENT ROW)
{%- endmacro %}

{% macro trailing_median_finish(window_col) -%}
  {{ return(adapter.dispatch('trailing_median_finish', 'datatrust')(window_col)) }}
{%- endmacro %}

{% macro default__trailing_median_finish(window_col) -%}
  {{ window_col }}
{%- endmacro %}

{% macro duckdb__trailing_median_finish(window_col) -%}
  {{ window_col }}
{%- endmacro %}

{% macro bigquery__trailing_median_finish(window_col) -%}
  (SELECT AVG(v) FROM (SELECT v, ROW_NUMBER() OVER (ORDER BY v) AS rn, COUNT(*) OVER () AS cnt FROM UNNEST({{ window_col }}) AS v) WHERE rn IN (DIV(cnt + 1, 2), DIV(cnt + 2, 2)))
{%- endmacro %}
