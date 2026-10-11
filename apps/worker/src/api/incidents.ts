import { Hono } from 'hono';
import { type HonoEnv, requireRole } from '../hono';
import { getIncident, type IncidentBriefRow, listIncidents } from '../store/repo';

export const incidents = new Hono<HonoEnv>();

function parse<T>(text: string | null): T | null {
  return text ? (JSON.parse(text) as T) : null;
}

function brief(row: IncidentBriefRow) {
  return {
    incidentId: row.incident_id,
    runId: row.run_id,
    trigger: row.trigger,
    status: row.status,
    createdAt: row.created_at,
    topCandidate: row.top_candidate,
    summaryProvider: row.summary_provider,
    summaryFallback: row.summary_fallback === 1,
  };
}

incidents.get('/', requireRole('viewer', 'operator'), async (c) => {
  const rows = await listIncidents(c.env.DB, c.req.query('runId') ?? null);
  return c.json({ incidents: rows.map(brief) });
});

incidents.get('/:id', requireRole('viewer', 'operator'), async (c) => {
  const row = await getIncident(c.env.DB, c.req.param('id'));
  if (!row) return c.json({ error: 'not_found' }, 404);
  const full = await c.env.ARTIFACTS.get(`incidents/${row.incident_id}.json`);
  if (full) return c.json(await full.json());
  const ranked = parse<Array<{ node: string }>>(row.ranked_json) ?? [];
  return c.json({
    ...brief({ ...row, top_candidate: ranked[0]?.node ?? null }),
    failingChecks: parse(row.failing_checks_json),
    ranked: parse(row.ranked_json),
    summary: parse(row.summary_json),
    summaryDraft: parse(row.summary_draft_json),
    summaryModel: row.summary_model,
    summaryAttempts: row.summary_attempts,
    summaryFallbackReason: row.summary_fallback_reason,
    provenance: parse(row.provenance_json),
  });
});
