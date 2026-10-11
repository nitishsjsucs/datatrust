import { edgesFromEvent, makeResolver, parseRunEvent, type RelationsMap } from '@datatrust/rca';
import type { AppEnv } from '../env';
import { LineageMessage } from '../schemas';
import { markLineageProcessed } from '../store/repo';

/**
 * dt-lineage-events: read the OpenLineage event from R2, resolve datasets by (schema, table) against the
 * run's relations.json, and upsert column and dataset edges (SPEC 9, 13.3).
 */
export async function handleLineageEvents(batch: MessageBatch<unknown>, env: AppEnv): Promise<void> {
  const relationsCache = new Map<string, RelationsMap | null>();
  const relationsFor = async (runId: string) => {
    if (!relationsCache.has(runId)) {
      const obj = await env.ARTIFACTS.get(`runs/${runId}/relations.json`);
      relationsCache.set(runId, obj ? ((await obj.json()) as RelationsMap) : null);
    }
    return relationsCache.get(runId) ?? null;
  };
  const edge = env.DB.prepare(
    `INSERT INTO lineage_edges (run_id, src_node, src_column, dst_node, dst_column) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
  );
  for (const msg of batch.messages) {
    const parsed = LineageMessage.safeParse(msg.body);
    if (!parsed.success) {
      msg.ack();
      console.error('dt-lineage-events: malformed message');
      continue;
    }
    const { runId, eventId, r2Key } = parsed.data;
    try {
      const relations = await relationsFor(runId);
      if (!relations) throw new Error(`relations not uploaded yet for ${runId}`);
      const obj = await env.ARTIFACTS.get(r2Key);
      if (!obj) throw new Error(`missing ${r2Key}`);
      const edges = edgesFromEvent(parseRunEvent(await obj.json()), makeResolver(relations));
      const stmts = [
        ...edges.columnEdges.map((e) => edge.bind(runId, e.from.node, e.from.column ?? '*', e.to.node, e.to.column ?? '*')),
        ...edges.datasetEdges.map((e) => edge.bind(runId, e.from, '*', e.to, '*')),
      ];
      for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
      await markLineageProcessed(env.DB, runId, eventId);
      msg.ack();
    } catch (err) {
      console.error('dt-lineage-events', err);
      msg.retry({ delaySeconds: 2 });
    }
  }
}
