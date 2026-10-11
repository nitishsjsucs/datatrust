/** In-test RS256 keys and Access-style tokens (no private key is ever committed). */
import { env } from 'cloudflare:workers';
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from 'jose';
import type { AppEnv } from '../../src/env';

export const ISSUER = 'http://127.0.0.1:8792/dev-access';
export const AUD = 'datatrust-test';
export const KID = 'test-kid-1';
export const OPERATOR = 'operator@example.com';
export const VIEWER = 'viewer@example.com';
export const RUNNER_CLIENT_ID = 'dev-runner.access';

export const ROLE_MAP = {
  emails: { [OPERATOR]: ['operator', 'viewer'], [VIEWER]: ['viewer'] },
  serviceTokens: { [RUNNER_CLIENT_ID]: ['runner'] },
};

export interface Keys {
  privateKey: CryptoKey;
  publicJwk: Record<string, unknown>;
  jwks: { keys: Array<Record<string, unknown>> };
}

export async function makeKeys(kid = KID): Promise<Keys> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  return { privateKey, publicJwk, jwks: { keys: [publicJwk] } };
}

export async function mint(
  keys: Keys,
  claims: JWTPayload,
  opts: { iss?: string; aud?: string; kid?: string; exp?: number | string } = {},
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: opts.kid ?? KID })
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '1h')
    .sign(keys.privateKey);
}

/** Human token: email claim, like an Access login. */
export const humanClaims = (email: string): JWTPayload => ({ email, sub: `user-${email}`, type: 'app' });

/** Service-token payload as documented: common_name = Client ID, empty sub, no email. */
export const serviceClaims = (clientId = RUNNER_CLIENT_ID): JWTPayload => ({
  common_name: clientId,
  sub: '',
  type: 'app',
});

export function testEnv(keys: Keys, overrides: Partial<AppEnv> = {}): AppEnv {
  return {
    ...(env as unknown as AppEnv),
    ENVIRONMENT: 'local',
    ACCESS_MODE: 'local-jwks',
    SUMMARIZER: 'template',
    ACCESS_ISSUER: ISSUER,
    ACCESS_AUD: AUD,
    ACCESS_JWKS_JSON: JSON.stringify(keys.jwks),
    ROLE_MAP_JSON: JSON.stringify(ROLE_MAP),
    ...overrides,
  };
}
