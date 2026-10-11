/** DataTrust Worker entry point: HTTP API, queue consumers and the two workflows (no scheduled handler in v1). */
import { createApp } from './app';
import type { AppEnv } from './env';
import { queue } from './queues/router';

export { InvestigationWorkflow } from './workflows/investigation';
export { ValidationRunWorkflow } from './workflows/validation-run';

const app = createApp();

export default {
  fetch(request: Request, env: AppEnv, ctx: ExecutionContext) {
    return app.fetch(request, env, ctx);
  },
  async queue(batch: MessageBatch<unknown>, env: AppEnv) {
    await queue(batch, env);
  },
} satisfies ExportedHandler<AppEnv>;
