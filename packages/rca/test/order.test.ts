/**
 * Ordering uses one module-scope Intl.Collator (SPEC 28.5.4) and must order every id exactly as
 * `localeCompare` did, so no ranking, trace or tie-break changes.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareIds } from '../src/order';
import relations from './fixtures/relations.seed101.json';
import worker from '../../../apps/worker/test/fixtures/investigation.s01.seed101.json';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

const root = join(import.meta.dirname, '..', '..', '..');

describe('compareIds', () => {
  it('replaces every localeCompare in the RCA package and the Worker', () => {
    const files = [...sourceFiles(join(root, 'packages', 'rca', 'src')), ...sourceFiles(join(root, 'apps', 'worker', 'src'))];
    expect(files.length).toBeGreaterThan(20);
    const offenders = files.filter((f) => readFileSync(f, 'utf8').includes('localeCompare('));
    expect(offenders).toEqual([]);
  });

  it('orders every node, column and probe id in the fixtures exactly as localeCompare', () => {
    const nodes = relations.nodes as Record<string, { columns?: Record<string, unknown> }>;
    const ids = new Set<string>(Object.keys(nodes));
    for (const n of Object.values(nodes)) for (const c of Object.keys(n.columns ?? {})) ids.add(c);
    for (const p of (worker as { probeResults: Array<{ probeId: string }> }).probeResults) ids.add(p.probeId);
    for (const id of ['*', 'A', 'a', 'B', '_x', 'x_1', 'x-1', 'X10', 'x9', 'Ä', 'z']) ids.add(id);
    const list = [...ids];
    expect(list.length).toBeGreaterThan(150);
    expect([...list].sort(compareIds)).toEqual([...list].sort((a, b) => a.localeCompare(b)));
    for (const a of list) for (const b of list) expect(Math.sign(compareIds(a, b))).toBe(Math.sign(a.localeCompare(b)));
  });
});
