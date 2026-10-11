{#-
  Render every dialect macro branch for one dialect without a warehouse connection (SPEC 7.3):
    dbt run-operation print_dialect_macros --args '{dialect: bigquery}'
  Prints one line `DIALECT_MACROS_JSON=<json>` mapping macro name to rendered SQL. CI checks the BigQuery
  text for constructs BigQuery rejects, because `dbt parse` and sqlglot accept some invalid BigQuery SQL.
-#}
{% macro print_dialect_macros(dialect='bigquery') %}
  {% set out = {} %}
  {% if dialect == 'bigquery' %}
    {% do out.update({
      'tz_local_date': bigquery__tz_local_date('entered_at', "'Asia/Kolkata'"),
      'tz_local_hour': bigquery__tz_local_hour('entered_at', "'Asia/Kolkata'"),
      'date_spine': bigquery__date_spine("date '2025-01-01'", "date '2025-12-31'"),
      'safe_divide': bigquery__safe_divide('a', 'b'),
      'int_div': bigquery__int_div('base_salary_local_minor + 6', '12'),
      'trailing_median': bigquery__trailing_median('rate_to_usd', 'currency', 'rate_date', 29),
      'trailing_median_finish': bigquery__trailing_median_finish('trailing_window'),
      'ordered_path': bigquery__ordered_path('stage', 'entered_at, stage_order'),
      'days_between': bigquery__days_between('applied_local_date', 'hire_date'),
      'month_start': bigquery__month_start('hire_date'),
      'time_travel': bigquery__time_travel('`project.datatrust_marts.fct_hires`', 1760000000000, 'fct_hires'),
      'dt_cast_money': 'cast(x as ' ~ bigquery__dt_type('money') ~ ')',
      'dt_cast_rate': 'cast(x as ' ~ bigquery__dt_type('rate') ~ ')',
      'dt_cast_int': 'cast(x as ' ~ bigquery__dt_type('int') ~ ')',
      'dt_cast_string': 'cast(x as ' ~ bigquery__dt_type('string') ~ ')',
      'dt_cast_ts': 'cast(x as ' ~ bigquery__dt_type('ts') ~ ')',
      'dt_cast_date': 'cast(x as ' ~ bigquery__dt_type('date') ~ ')',
      'dt_cast_bool': 'cast(x as ' ~ bigquery__dt_type('bool') ~ ')',
    }) %}
  {% else %}
    {% do out.update({
      'tz_local_date': duckdb__tz_local_date('entered_at', "'Asia/Kolkata'"),
      'tz_local_hour': duckdb__tz_local_hour('entered_at', "'Asia/Kolkata'"),
      'date_spine': duckdb__date_spine("date '2025-01-01'", "date '2025-12-31'"),
      'safe_divide': duckdb__safe_divide('a', 'b'),
      'int_div': duckdb__int_div('base_salary_local_minor + 6', '12'),
      'trailing_median': duckdb__trailing_median('rate_to_usd', 'currency', 'rate_date', 29),
      'trailing_median_finish': duckdb__trailing_median_finish('trailing_window'),
      'ordered_path': duckdb__ordered_path('stage', 'entered_at, stage_order'),
      'days_between': duckdb__days_between('applied_local_date', 'hire_date'),
      'month_start': duckdb__month_start('hire_date'),
      'time_travel': duckdb__time_travel('marts.fct_hires', 'run_x', 'fct_hires'),
      'dt_cast_money': 'cast(x as ' ~ duckdb__dt_type('money') ~ ')',
      'dt_cast_rate': 'cast(x as ' ~ duckdb__dt_type('rate') ~ ')',
      'dt_cast_int': 'cast(x as ' ~ duckdb__dt_type('int') ~ ')',
      'dt_cast_string': 'cast(x as ' ~ duckdb__dt_type('string') ~ ')',
      'dt_cast_ts': 'cast(x as ' ~ duckdb__dt_type('ts') ~ ')',
      'dt_cast_date': 'cast(x as ' ~ duckdb__dt_type('date') ~ ')',
      'dt_cast_bool': 'cast(x as ' ~ duckdb__dt_type('bool') ~ ')',
    }) %}
  {% endif %}
  {% set cleaned = {} %}
  {% for k, v in out.items() %}
    {% do cleaned.update({k: (v | string | trim)}) %}
  {% endfor %}
  {{ print('DIALECT_MACROS_JSON=' ~ tojson(cleaned)) }}
{% endmacro %}
