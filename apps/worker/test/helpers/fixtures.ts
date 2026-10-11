import type { CheckResult, ProbeResult, RelationsMap } from '@datatrust/rca';
import fixture from '../fixtures/investigation.s01.seed101.json';

/**
 * A real offline trial (scenario S01, duplicate hires, seed 101) recorded by
 * `uv run python pipelines/tests/record_fixtures.py worker`: dbt check results, relations.json, model-run
 * OpenLineage events (namespaces scrubbed) and sanitized probe results.
 */
export const s01 = fixture as unknown as {
  checks: CheckResult[];
  relations: RelationsMap;
  events: unknown[];
  probeResults: ProbeResult[];
};

export const seed101Events = s01.events;
export const seed101Relations = s01.relations;
