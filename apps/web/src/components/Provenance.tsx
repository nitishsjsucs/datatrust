import { isStandIn } from '../format';

/** Where this incident's evidence and summary came from; local stand-ins are labelled (ADR-0003). */
export function Provenance({ provenance }: { provenance: Record<string, unknown> }) {
  const summarizer = (provenance['summarizer'] ?? {}) as Record<string, unknown>;
  const rows: Array<[string, string]> = [
    ['Environment', String(provenance['environment'] ?? 'n/a')],
    ['Warehouse', String(provenance['warehouse'] ?? 'n/a')],
    ['Summarizer', `${String(summarizer['provider'] ?? 'n/a')} (${String(summarizer['model'] ?? 'n/a')})`],
    ['Lake sink', String(provenance['lakeSink'] ?? 'n/a')],
    ['Candidates traced', String(provenance['candidateCount'] ?? 'n/a')],
  ];
  return (
    <section className="card">
      <h2>Provenance</h2>
      <table className="kv">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <th>{k}</th>
              <td>
                {v} {isStandIn(v) && <span className="tag warn">local stand-in</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
