#!/usr/bin/env node
// Render apps/worker/wrangler.prod.template.jsonc to apps/worker/wrangler.prod.jsonc (gitignored).
//   node scripts/render-prod-config.mjs --d1 <id> --stream <id> [--team https://<team>.cloudflareaccess.com]
//   node scripts/render-prod-config.mjs --placeholders     (CI: fake ids, only for `wrangler deploy --dry-run`)
// Without a team domain the fail-closed placeholder https://unset.cloudflareaccess.com is used, so every
// authenticated route answers 401 until Access is configured.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const placeholders = args.includes('--placeholders');
const values = {
  D1_DATABASE_ID: placeholders ? '00000000-0000-4000-8000-000000000001' : opt('--d1'),
  STREAM_ID: placeholders ? '0123456789abcdef0123456789abcdef' : opt('--stream'),
  ACCESS_TEAM_DOMAIN: opt('--team') || 'https://unset.cloudflareaccess.com',
};
const problems = [];
if (!/^[0-9a-f-]{32,36}$/i.test(values.D1_DATABASE_ID ?? '')) problems.push('--d1 must be the D1 database id');
if (!/^[0-9a-zA-Z_-]{8,64}$/.test(values.STREAM_ID ?? '')) problems.push('--stream must be the Pipelines stream id');
if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(values.ACCESS_TEAM_DOMAIN)) {
  problems.push('--team must look like https://<team>.cloudflareaccess.com');
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(2);
}
let text = readFileSync(join(root, 'apps/worker/wrangler.prod.template.jsonc'), 'utf8');
for (const [k, v] of Object.entries(values)) text = text.replaceAll('${' + k + '}', v);
if (text.includes('${')) {
  console.error('unrendered placeholder left in the template');
  process.exit(2);
}
const out = join(root, 'apps/worker/wrangler.prod.jsonc');
writeFileSync(out, text);
console.error(`wrote ${out}`);
