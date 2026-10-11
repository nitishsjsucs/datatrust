/**
 * Recovery commands attached to an incident for a human to run (SPEC 2 non-goals, 17). Never executed by
 * DataTrust and never written by the model.
 */
import type { RankedCandidate, RelationsMap } from '@datatrust/rca';

export interface RecoveryCommand {
  node: string;
  command: string;
  note: string;
}

export function recoveryCommands(input: {
  target: string;
  runId: string;
  ranked: RankedCandidate[];
  relations: RelationsMap;
  now?: number;
}): RecoveryCommand[] {
  const top = input.ranked[0];
  if (!top) return [];
  const node = input.relations.nodes[top.node];
  if (!node) return [];
  if (input.target === 'bigquery') {
    if (node.kind === 'model' && node.materialization !== 'table') {
      return [{ node: top.node, command: `dbt build --target bigquery --select ${node.name}`, note: 'views are rebuilt, not restored' }];
    }
    const now = input.now ?? Date.now();
    const asOf = now - 24 * 3600 * 1000;
    const stamp = new Date(now).toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const table = `${node.database}:${node.schema}.${node.identifier}`;
    return [
      {
        node: top.node,
        command: `bq cp ${table}@${asOf} ${table}_restored_${stamp}`,
        note: 'restores into a new table from BigQuery time travel (7-day window); pick the epoch ms of the last green run; run as your own identity, then reapply policy tags with dbt',
      },
    ];
  }
  if (node.kind === 'source') {
    return [
      {
        node: top.node,
        command: `uv run datatrust load --seed <seed> --target duckdb`,
        note: `reload raw.${node.identifier} from a corrected extract (local stand-in)`,
      },
    ];
  }
  if (node.schema === 'marts' && node.materialization === 'table') {
    return [
      {
        node: top.node,
        command: `uv run datatrust restore --from-snapshot <last green run id> ${node.name}`,
        note: 'local stand-in for time travel: marts are snapshotted to Parquet after every green run',
      },
    ];
  }
  return [
    {
      node: top.node,
      command: `uv run datatrust build`,
      note: `fix ${node.name} (or its inputs), then rebuild; only marts have snapshots locally`,
    },
  ];
}
