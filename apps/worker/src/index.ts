/** DataTrust Worker entry point: HTTP API (no scheduled handler in v1, review finding I6). */
import { createApp } from './app';
import type { AppEnv } from './env';

const app = createApp();

export default {
  fetch(request: Request, env: AppEnv, ctx: ExecutionContext) {
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<AppEnv>;
