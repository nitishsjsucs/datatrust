/** IncidentSummary schema (SPEC 13.6) and its JSON Schema for Workers AI JSON mode. */
import { z } from 'zod';

export const IncidentSummarySchema = z
  .object({
    title: z.string().min(1).max(160),
    impact: z.string().min(1).max(600),
    suspectedRootCause: z
      .object({
        node: z.string().min(1).max(300),
        column: z.string().max(200).nullable(),
        confidence: z.enum(['high', 'medium', 'low']),
      })
      .strict(),
    reasoning: z.array(z.string().min(1).max(400)).max(5),
    evidenceRefs: z.array(z.string().max(200)).max(12),
    diagnosticSqlIds: z.array(z.string().max(200)).max(6),
    nextSteps: z.array(z.string().min(1).max(400)).max(5),
  })
  .strict();

export type IncidentSummary = z.infer<typeof IncidentSummarySchema>;

/** JSON Schema handed to Workers AI `response_format: {type: 'json_schema'}` and quoted in the prompt. */
export const incidentSummaryJsonSchema: Record<string, unknown> = z.toJSONSchema(IncidentSummarySchema) as Record<
  string,
  unknown
>;
