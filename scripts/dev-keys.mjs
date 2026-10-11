#!/usr/bin/env node
// Local Access stand-in (SPEC 15): an RS256 keypair under .dev/keys/ (gitignored) and the Worker's local
// secrets in apps/worker/.dev.vars. Idempotent: existing keys and the evidence key are reused.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportJWK, generateKeyPair } from 'jose';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const keysDir = join(root, '.dev', 'keys');
const privPath = join(keysDir, 'private.jwk.json');
const pubPath = join(keysDir, 'jwks.json');
const evidencePath = join(root, '.dev', 'evidence_hmac_key');
const devVars = join(root, 'apps', 'worker', '.dev.vars');

export const LOCAL = {
  issuer: 'http://127.0.0.1:8792/dev-access',
  audience: 'datatrust-local',
  kid: 'datatrust-local-1',
  operator: 'operator@example.com',
  viewer: 'viewer@example.com',
  runnerClientId: 'dev-runner.access',
};

mkdirSync(keysDir, { recursive: true, mode: 0o700 });
if (!existsSync(privPath)) {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const priv = { ...(await exportJWK(privateKey)), kid: LOCAL.kid, alg: 'RS256' };
  const pub = { ...(await exportJWK(publicKey)), kid: LOCAL.kid, alg: 'RS256', use: 'sig' };
  writeFileSync(privPath, JSON.stringify(priv), { mode: 0o600 });
  writeFileSync(pubPath, JSON.stringify({ keys: [pub] }));
  console.error(`generated ${privPath}`);
} else {
  console.error(`reusing ${privPath}`);
}
if (!existsSync(evidencePath)) writeFileSync(evidencePath, randomBytes(32).toString('hex'), { mode: 0o600 });

const jwks = readFileSync(pubPath, 'utf8');
const roleMap = {
  emails: { [LOCAL.operator]: ['operator', 'viewer'], [LOCAL.viewer]: ['viewer'] },
  serviceTokens: { [LOCAL.runnerClientId]: ['runner'] },
};
const lines = [
  '# Written by `npm run dev:keys` (local stand-in for Cloudflare Access). Never used in production.',
  `ACCESS_JWKS_JSON='${jwks}'`,
  `ACCESS_AUD=${LOCAL.audience}`,
  `ROLE_MAP_JSON='${JSON.stringify(roleMap)}'`,
  `EVIDENCE_HMAC_KEY=${readFileSync(evidencePath, 'utf8').trim()}`,
  '',
];
writeFileSync(devVars, lines.join('\n'), { mode: 0o600 });
console.error(`wrote ${devVars}`);
