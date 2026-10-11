/**
 * Prompt builder shared by every summarizer (SPEC 13.6). The prompt lists each evidence key with its field
 * names but never the values, so the model cannot copy a wrong number; it must cite {ev:key.field}.
 */
import type { SanitizedEvidence } from '../evidence/evidence';
import { evidenceFields } from './render';
import { incidentSummaryJsonSchema } from './schema';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const SYSTEM = [
  'You are a data-quality incident analyst for a workforce data warehouse (HR, recruiting, compensation, payroll).',
  'Write an incident summary as a single JSON object that follows the JSON Schema below.',
  'Rules:',
  '- Never write digits. To cite a number, write a placeholder {ev:<key>.<field>} using only the keys and fields listed in the evidence. The server replaces placeholders with the real values.',
  '- Spell out small quantities in words ("one", "three") if you need them.',
  '- suspectedRootCause.node must be the full node id of one listed candidate (for example source.datatrust.raw.hires), normally the rank-one candidate unless the evidence clearly points elsewhere.',
  '- Do not repeat the run id or the incident id in any text field.',
  '- evidenceRefs lists evidence keys you relied on; diagnosticSqlIds lists probe keys whose SQL a human should run.',
  '- Do not invent identifiers, people, values or SQL. Sample keys are pseudonymous tokens; never try to reverse them.',
  '- nextSteps are short actions for a data engineer. Do not write recovery or restore commands; the server attaches them.',
].join('\n');

export function evidenceListing(ev: SanitizedEvidence): string {
  const fields = evidenceFields(ev);
  const lines: string[] = [];
  lines.push(`Incident ${ev.incidentId}, run ${ev.runId}, trigger: ${ev.trigger}.`);
  lines.push('Failing checks (key: check id, category, tested node and columns; fields):');
  for (const c of ev.failingChecks) {
    lines.push(`- ${c.key}: ${c.checkId}, ${c.category}, ${c.node} [${c.columns.join(', ')}]; fields: ${[...(fields.get(c.key)?.keys() ?? [])].join(', ')}`);
  }
  lines.push('Ranked root-cause candidates (key: node, traced columns, supporting probes; fields):');
  for (const c of ev.candidates) {
    lines.push(
      `- ${c.key}: ${c.node} [${c.columns.join(', ')}] probes: ${c.probes.join(', ') || 'none'}; fields: ${[...(fields.get(c.key)?.keys() ?? [])].join(', ')}`,
    );
  }
  lines.push('Diagnostic probes (key: probe kind, node, columns, metric name; fields):');
  for (const p of ev.probes) {
    lines.push(`- ${p.key}: ${p.probe} on ${p.node} [${p.columns.join(', ')}], metric ${p.metric}; fields: value, anomaly`);
  }
  return lines.join('\n');
}

export function buildPrompt(ev: SanitizedEvidence): ChatMessage[] {
  return [
    { role: 'system', content: `${SYSTEM}\nJSON Schema:\n${JSON.stringify(incidentSummaryJsonSchema)}` },
    { role: 'user', content: `${evidenceListing(ev)}\n\nReturn only the JSON object.` },
  ];
}

export function buildRepairPrompt(ev: SanitizedEvidence, previous: string, violations: string[]): ChatMessage[] {
  return [
    ...buildPrompt(ev),
    { role: 'assistant', content: previous },
    {
      role: 'user',
      content: `The JSON above failed validation:\n${violations.map((v) => `- ${v}`).join('\n')}\nFix exactly these problems and return the corrected JSON object only.`,
    },
  ];
}
