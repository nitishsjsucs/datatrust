#!/usr/bin/env node
// Mint a 1-hour local Access-style JWT (SPEC 15): npm run dev:token -- --role runner|operator|viewer
// Runner tokens look like Cloudflare service-token JWTs (common_name = Client ID, empty sub, no email).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importJWK, SignJWT } from 'jose';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const role = args[args.indexOf('--role') + 1] ?? 'operator';
const LOCAL = {
  issuer: 'http://127.0.0.1:8792/dev-access',
  audience: 'datatrust-local',
  kid: 'datatrust-local-1',
};
const claims = {
  runner: { common_name: 'dev-runner.access', sub: '', type: 'app' },
  operator: { email: 'operator@example.com', sub: 'dev-operator', type: 'app' },
  viewer: { email: 'viewer@example.com', sub: 'dev-viewer', type: 'app' },
}[role];
if (!claims) {
  console.error(`unknown role ${role}; use runner, operator or viewer`);
  process.exit(2);
}
let jwk;
try {
  jwk = JSON.parse(readFileSync(join(root, '.dev', 'keys', 'private.jwk.json'), 'utf8'));
} catch {
  console.error('no local keys; run `npm run dev:keys` first');
  process.exit(1);
}
const key = await importJWK(jwk, 'RS256');
const token = await new SignJWT(claims)
  .setProtectedHeader({ alg: 'RS256', kid: LOCAL.kid })
  .setIssuer(LOCAL.issuer)
  .setAudience(LOCAL.audience)
  .setIssuedAt()
  .setExpirationTime('1h')
  .sign(key);
process.stdout.write(`${token}\n`);
