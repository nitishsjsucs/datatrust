import { useEffect, useState } from 'react';
import { api, type IncidentBrief } from '../api';
import { shortNode, when } from '../format';

export function IncidentsPage() {
  const [items, setItems] = useState<IncidentBrief[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ incidents: IncidentBrief[] }>('/api/incidents')
      .then((r) => setItems(r.incidents))
      .catch((e: Error) => setError(e.message));
  }, []);
  if (error) return <p className="error">{error}. Locally, set a dev token (top right).</p>;
  if (!items) return <p className="muted">Loading incidents…</p>;
  if (items.length === 0) return <p className="muted">No incidents yet. Start a run with a scenario to create one.</p>;
  return (
    <section>
      <h1>Incidents</h1>
      <table className="grid">
        <thead>
          <tr>
            <th>Created</th>
            <th>Trigger</th>
            <th>Top candidate</th>
            <th>Summary</th>
            <th>Run</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.incidentId}>
              <td>
                <a href={`#/incidents/${i.incidentId}`}>{when(i.createdAt)}</a>
              </td>
              <td>{i.trigger}</td>
              <td className="mono">{i.topCandidate ? shortNode(i.topCandidate) : 'n/a'}</td>
              <td>
                {i.summaryProvider ?? 'n/a'}
                {i.summaryFallback ? <span className="tag warn">template fallback</span> : null}
              </td>
              <td className="mono small">{i.runId}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
