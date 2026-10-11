import { useEffect, useState } from 'react';
import { api, type Incident } from '../api';
import { LineagePath } from '../components/LineagePath';
import { Provenance } from '../components/Provenance';
import { pct, score, shortNode, when } from '../format';

export function IncidentPage({ id }: { id: string }) {
  const [inc, setInc] = useState<Incident | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<Incident>(`/api/incidents/${id}`)
      .then(setInc)
      .catch((e: Error) => setError(e.message));
  }, [id]);
  if (error) return <p className="error">{error}</p>;
  if (!inc) return <p className="muted">Loading incident…</p>;
  const s = inc.summary;
  const failingNodes = new Set(inc.failingChecks.map((c) => c.node));
  return (
    <article className="incident">
      <p className="muted small">
        <a href="#/">Incidents</a> / {inc.incidentId}
      </p>
      <h1>{s?.title ?? inc.incidentId}</h1>
      <p className="muted">
        Run <span className="mono">{inc.runId}</span>, {inc.trigger}, {when(inc.createdAt)}
      </p>
      {s && (
        <section className="card">
          <h2>Summary</h2>
          <p>{s.impact}</p>
          <p>
            Suspected root cause: <strong className="mono">{shortNode(s.suspectedRootCause.node)}</strong>
            {s.suspectedRootCause.column ? <span className="mono">.{s.suspectedRootCause.column}</span> : null}{' '}
            <span className={`tag ${s.suspectedRootCause.confidence}`}>{s.suspectedRootCause.confidence} confidence</span>
          </p>
          <ul>
            {s.reasoning.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          {s.nextSteps.length > 0 && (
            <>
              <h3>Next steps</h3>
              <ul>
                {s.nextSteps.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </>
          )}
          <p className="muted small">
            Written by {inc.summaryProvider ?? 'n/a'} ({inc.summaryModel ?? 'n/a'}), attempts {inc.summaryAttempts ?? 'n/a'}
            {inc.summaryFallback ? `; template fallback: ${inc.summaryFallbackReason ?? ''}` : ''}. Numbers are filled in
            by the server from the evidence, never written by the model.
          </p>
        </section>
      )}
      <section className="card">
        <h2>Failing checks</h2>
        <table className="grid">
          <thead>
            <tr>
              <th>Check</th>
              <th>Category</th>
              <th>Node</th>
              <th>Columns</th>
              <th>Failures</th>
            </tr>
          </thead>
          <tbody>
            {inc.failingChecks.map((c) => (
              <tr key={c.checkId}>
                <td className="mono">{c.checkId}</td>
                <td>{c.category}</td>
                <td className="mono">{shortNode(c.node)}</td>
                <td className="mono small">{c.columns.join(', ')}</td>
                <td>{c.failures}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="card">
        <h2>Ranked root-cause candidates</h2>
        <table className="grid">
          <thead>
            <tr>
              <th>#</th>
              <th>Node</th>
              <th>Score</th>
              <th>Coverage</th>
              <th>Own anomaly</th>
              <th>Changed</th>
              <th>Hops</th>
            </tr>
          </thead>
          <tbody>
            {inc.ranked.map((c) => (
              <tr key={c.node} className={c.rank === 1 ? 'top' : undefined}>
                <td>{c.rank}</td>
                <td className="mono">
                  {shortNode(c.node)} <span className="muted small">{c.kind}</span>
                </td>
                <td>{score(c.score)}</td>
                <td>{pct(c.features.coverage)}</td>
                <td>{score(c.features.ownAnomaly)}</td>
                <td>{c.features.changed ? 'yes' : 'no'}</td>
                <td>{c.features.distance}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="card">
        <h2>Column-level lineage path</h2>
        <LineagePath nodes={inc.lineagePath} failing={failingNodes} top={inc.ranked[0]?.node ?? null} />
      </section>
      <section className="card">
        <h2>Supporting diagnostic SQL</h2>
        {inc.diagnosticSql.length === 0 && <p className="muted">No probe flagged an anomaly.</p>}
        {inc.diagnosticSql.map((d) => (
          <details key={d.key}>
            <summary className="mono">{d.key}</summary>
            {d.sql.map((q) => (
              <pre key={q}>{q}</pre>
            ))}
          </details>
        ))}
      </section>
      {inc.recovery && inc.recovery.length > 0 && (
        <section className="card">
          <h2>Recovery (run by a person)</h2>
          {inc.recovery.map((r) => (
            <div key={r.command}>
              <pre>{r.command}</pre>
              <p className="muted small">{r.note}</p>
            </div>
          ))}
        </section>
      )}
      <Provenance provenance={inc.provenance} />
    </article>
  );
}
