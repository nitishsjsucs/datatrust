import type { RelationsMap } from '@datatrust/rca';
import events from '../fixtures/openlineage.models.seed101.json';
import relations from '../fixtures/relations.seed101.json';

/** Recorded seed-101 dbt-ol model events (namespaces scrubbed) and relations.json. */
export const seed101Events = events as unknown[];
export const seed101Relations = relations as unknown as RelationsMap;
