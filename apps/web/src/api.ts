/**
 * API client. In production Cloudflare Access authenticates the browser and adds the
 * Cf-Access-Jwt-Assertion header itself. Locally there is no Access, so a dev token
 * (`npm run dev:token -- --role viewer`) can be pasted once and is kept for this tab only.
 */
export interface IncidentBrief {
  incidentId: string;
  runId: string;
  trigger: string;
  status: string;
  createdAt: string;
  topCandidate: string | null;
  summaryProvider: string | null;
  summaryFallback: boolean;
}

export interface RankedCandidate {
  rank: number;
  node: string;
  kind: 'source' | 'model';
  score: number;
  features: { coverage: number; ownAnomaly: number; changed: number; unexplainedPass: number; distance: number };
  columns: string[];
  probes: string[];
}

export interface Incident {
  incidentId: string;
  runId: string;
  trigger: string;
  status: string;
  createdAt: string;
  failingChecks: Array<{ checkId: string; category: string; kind: string; node: string; columns: string[]; failures: number }>;
  lineagePath: Array<{ node: string; distance: number; columns: string[] }>;
  ranked: RankedCandidate[];
  diagnosticSql: Array<{ key: string; probeId: string; sql: string[] }>;
  summary: {
    title: string;
    impact: string;
    suspectedRootCause: { node: string; column: string | null; confidence: string };
    reasoning: string[];
    nextSteps: string[];
  } | null;
  recovery?: Array<{ node: string; command: string; note: string }>;
  summaryProvider: string | null;
  summaryModel: string | null;
  summaryAttempts: number | null;
  summaryFallback: boolean;
  summaryFallbackReason: string | null;
  provenance: Record<string, unknown>;
}

const TOKEN_KEY = 'datatrust.devToken';

export function devToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setDevToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage unavailable: the token lives only for this page view
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string): Promise<T> {
  const headers: Record<string, string> = {};
  const token = devToken();
  if (token) headers['Cf-Access-Jwt-Assertion'] = token;
  const res = await fetch(path, { headers, credentials: 'same-origin' });
  if (!res.ok) throw new ApiError(res.status, res.status === 401 ? 'Not signed in' : `HTTP ${res.status}`);
  return (await res.json()) as T;
}
