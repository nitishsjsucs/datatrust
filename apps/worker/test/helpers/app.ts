import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { createApp } from '../../src/app';
import type { AppEnv } from '../../src/env';

const app = createApp();

export async function request(
  env: AppEnv,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers = new Headers(opts.headers);
  if (opts.token) headers.set('Cf-Access-Jwt-Assertion', opts.token);
  if (opts.body !== undefined) headers.set('content-type', 'application/json');
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`http://worker${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}
