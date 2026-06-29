import { loadEnv } from "./config/env";
import { createBlindComputeApp } from "./workers/blind-compute/blind-compute.app";

const env = loadEnv();
const app = createBlindComputeApp({
  mpcNodeIds: env.mpcNodeIds,
  mpcShareStoreDir: env.mpcShareStoreDir || undefined,
  mpcThreshold: env.mpcThreshold,
  token: env.matcherComputeToken || undefined,
});

Bun.serve({
  port: env.matcherComputePort,
  fetch: (request) => app.handle(request),
});

console.log(`merkl blind compute listening on ${env.matcherComputePort}`);
