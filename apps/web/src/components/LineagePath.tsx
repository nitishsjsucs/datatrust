import { byDistance, shortNode } from '../format';

/** Upstream path from the failing checks (hop 0) to the raw sources, grouped by hop distance. */
export function LineagePath({
  nodes,
  failing,
  top,
}: {
  nodes: Array<{ node: string; distance: number; columns: string[] }>;
  failing: Set<string>;
  top: string | null;
}) {
  return (
    <ol className="path">
      {byDistance(nodes).map(([d, list]) => (
        <li key={d}>
          <span className="hop">{d === 0 ? 'tested' : `${d} hop${d > 1 ? 's' : ''} up`}</span>
          <div className="nodes">
            {list.map((n) => (
              <span
                key={n.node}
                className={`node${n.node === top ? ' suspect' : ''}${failing.has(n.node) ? ' failing' : ''}`}
                title={n.columns.join(', ')}
              >
                {shortNode(n.node)}
                {n.columns.length > 0 && <span className="cols"> [{n.columns.slice(0, 3).join(', ')}{n.columns.length > 3 ? ', …' : ''}]</span>}
              </span>
            ))}
          </div>
        </li>
      ))}
    </ol>
  );
}
