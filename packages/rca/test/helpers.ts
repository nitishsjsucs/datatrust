import { readFileSync } from 'node:fs';
import type { RelationsMap } from '../src/types';

export function fixturePath(name: string): string {
  return new URL(`./fixtures/${name}`, import.meta.url).pathname;
}

export function loadEvents(name = 'openlineage.seed101.jsonl'): unknown[] {
  return readFileSync(fixturePath(name), 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as unknown);
}

export function loadRelations(name = 'relations.seed101.json'): RelationsMap {
  return JSON.parse(readFileSync(fixturePath(name), 'utf8')) as RelationsMap;
}
