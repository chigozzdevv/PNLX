import { loadEnv } from "./config/env";
import { createBlindComputeApp } from "./workers/blind-compute/blind-compute.app";

const env = loadEnv();
const app = createBlindComputeApp({
  thresholdShareNodeIds: env.thresholdShareNodeIds,
  thresholdShareStoreDir: env.thresholdShareStoreDir || undefined,
  thresholdShareThreshold: env.thresholdShareThreshold,
  token: env.matcherComputeToken || undefined,
});

Bun.serve({
  port: env.matcherComputePort,
  fetch: (request) => app.handle(request),
});

console.log(`merkl blind compute listening on ${env.matcherComputePort}`);
