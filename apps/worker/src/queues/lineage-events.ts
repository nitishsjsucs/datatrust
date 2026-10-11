import { edgesFromEvent, makeResolver, parseRunEvent, type RelationsMap } from '@datatrust/rca';
import type { AppEnv } from '../env';
import { LineageBundleSchema } from '../schemas';
import { type EdgeRow, lineageBundleStatements } from '../store/repo';

/**
 * datatrust-lineage-events (max_batch_size 1): one message per lineage POST, up to 10 OpenLineage events in
 * R2. Resolve datasets by (schema, table) against the run's relations.json, then write the column and
 * dataset edges and the lineage_events rows with two set-based statements in one batch (SPEC 9, 13.3,
 * 28.5.2). Redelivery is harmless: both inserts are ON CONFLICT DO NOTHING.
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
  for (const msg of batch.messages) {
    const parsed = LineageBundleSchema.safeParse(msg.body);
    if (!parsed.success) {
      msg.ack();
      console.error('datatrust-lineage-events: malformed message');
      continue;
    }
    const { runId, events } = parsed.data;
    try {
      const relations = await relationsFor(runId);
      if (!relations) throw new Error(`relations not uploaded yet for ${runId}`);
      const resolver = makeResolver(relations);
      const rows = new Map<string, EdgeRow>();
      for (const ev of events) {
        const obj = await env.ARTIFACTS.get(ev.r2Key);
        if (!obj) throw new Error(`missing ${ev.r2Key}`);
        const edges = edgesFromEvent(parseRunEvent(await obj.json()), resolver);
        for (const e of edges.columnEdges) {
          const row: EdgeRow = [e.from.node, e.from.column ?? '*', e.to.node, e.to.column ?? '*'];
          rows.set(row.join('\u0000'), row);
        }
        for (const e of edges.datasetEdges) {
          const row: EdgeRow = [e.from, '*', e.to, '*'];
          rows.set(row.join('\u0000'), row);
        }
      }
      await env.DB.batch(lineageBundleStatements(env.DB, runId, [...rows.values()], events));
      msg.ack();
    } catch (err) {
      console.error('datatrust-lineage-events', err);
      msg.retry({ delaySeconds: 2 });
    }
  }
}
