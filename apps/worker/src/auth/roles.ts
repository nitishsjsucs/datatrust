/** Principals, roles and the role map (SPEC 15). */
export type Role = 'viewer' | 'operator' | 'runner';

export interface Principal {
  kind: 'human' | 'service';
  /** Email for humans, the service token Client ID (`common_name`) for service tokens. */
  id: string;
  roles: Role[];
}

export interface RoleMap {
  emails: Record<string, Role[]>;
  serviceTokens: Record<string, Role[]>;
}

const ROLES: ReadonlySet<string> = new Set(['viewer', 'operator', 'runner']);

export function parseRoleMap(json: string | undefined): RoleMap {
  const empty: RoleMap = { emails: {}, serviceTokens: {} };
  if (!json) return empty;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return empty;
  }
  if (!raw || typeof raw !== 'object') return empty;
  const clean = (o: unknown): Record<string, Role[]> => {
    const out: Record<string, Role[]> = {};
    if (!o || typeof o !== 'object') return out;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (Array.isArray(v)) out[k.toLowerCase()] = v.filter((r): r is Role => typeof r === 'string' && ROLES.has(r));
    }
    return out;
  };
  const r = raw as { emails?: unknown; serviceTokens?: unknown };
  return { emails: clean(r.emails), serviceTokens: clean(r.serviceTokens) };
}

export function rolesFor(map: RoleMap, kind: Principal['kind'], id: string): Role[] {
  const table = kind === 'service' ? map.serviceTokens : map.emails;
  return table[id.toLowerCase()] ?? [];
}

export function hasRole(p: Principal, allowed: Role[]): boolean {
  return p.roles.some((r) => allowed.includes(r));
}
