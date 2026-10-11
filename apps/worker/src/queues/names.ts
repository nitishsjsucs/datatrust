/** Queue names carry the repo prefix: one Cloudflare account serves four repos (SPEC 13.3, 28.5.8). */
export const QUEUES = {
  checkResults: 'datatrust-check-results',
  lineageEvents: 'datatrust-lineage-events',
  investigate: 'datatrust-investigate',
  auditEvents: 'datatrust-audit-events',
  dlq: 'datatrust-dlq',
} as const;
