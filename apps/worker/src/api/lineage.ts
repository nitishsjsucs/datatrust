import { upstreamClosure } from '@datatrust/rca';
import { Hono } from 'hono';
import { type HonoEnv, requireRole } from '../hono';
import { loadLineageGraph } from '../store/repo';

export const lineageRead = new Hono<HonoEnv>();

/** Upstream subgraph of one node (and optionally one column) for a run (SPEC 13.1). */
lineageRead.get('/:runId/upstream', requireRole('viewer', 'operator'), async (c) => {
  const node = c.req.query('node');
  if (!node) return c.json({ error: 'node is required' }, 400);
  const column = c.req.query('column') ?? null;
  const g = await loadLineageGraph(c.env.DB, c.req.param('runId'));
  if (!g.nodes[node]) return c.json({ error: 'not_found' }, 404);
  const closure = upstreamClosure(g, [{ node, column }], column ? 'column' : 'dataset');
  const inClosure = new Set(closure.keys());
  return c.json({
    runId: c.req.param('runId'),
    start: { node, column },
    nodes: [...closure.entries()]
      .map(([id, e]) => ({
        node: id,
        kind: g.nodes[id]?.kind,
        distance: e.distance,
        columns: [...e.columns].sort(),
        viaDataset: e.viaDataset,
      }))
      .sort((a, b) => a.distance - b.distance || a.node.localeCompare(b.node)),
    columnEdges: g.columnEdges.filter((e) => inClosure.has(e.from.node) && inClosure.has(e.to.node)),
    datasetEdges: g.datasetEdges.filter((e) => inClosure.has(e.from) && inClosure.has(e.to)),
  });
});
