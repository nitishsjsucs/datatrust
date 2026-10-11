/**
 * Investigation ids (SPEC 13.3): inv_<runId>_<trigger>_<hash8>, where hash8 is the first 8 hex characters of
 * SHA-256 over the canonical alert JSON ("00000000" for checks). At most 50 characters, matching the
 * documented Workflows id pattern, so an alert never collides with the checks investigation of the same run
 * and a redelivered message maps to the same id.
 */
import { canonicalJson, sha256Hex } from './ids';
import type { Alert } from './schemas';

export async function investigationIds(
  runId: string,
  trigger: 'checks' | 'alert',
  alert?: Alert,
): Promise<{ instanceId: string; incidentId: string }> {
  const hash8 = trigger === 'checks' ? '00000000' : (await sha256Hex(canonicalJson(alert ?? {}))).slice(0, 8);
  return { instanceId: `inv_${runId}_${trigger}_${hash8}`, incidentId: `inc_${runId}_${trigger}_${hash8}` };
}
