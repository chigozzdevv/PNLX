import { loadEnv } from "./config/env";
import { createExternalMatcherApp } from "./workers/external-matcher/external-matcher.app";

const env = loadEnv();
const app = createExternalMatcherApp({
  computeBackend: env.matcherComputeBackend,
  computeToken: env.matcherComputeToken || undefined,
  computeUrl: env.matcherComputeUrl || undefined,
  mpcNodeIds: env.mpcNodeIds,
  mpcThreshold: env.mpcThreshold,
  privateMatchingRequired: env.privateMatchingRequired,
  storePath: env.protocolStorePath || undefined,
  token: env.matcherApiToken,
});
const port = env.matcherPort;

Bun.serve({
  port,
  fetch: (request) => app.handle(request),
});

console.log(`merkl external matcher listening on ${port}`);
