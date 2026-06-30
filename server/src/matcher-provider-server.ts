import { loadEnv } from "@/config/env";
import { createMatcherProviderApp } from "@/workers/matcher-provider/matcher-provider.app";

const env = loadEnv();
const app = createMatcherProviderApp({
  thresholdShareNodeIds: env.thresholdShareNodeIds,
  thresholdShareStoreDir: env.thresholdShareStoreDir || undefined,
  thresholdShareThreshold: env.thresholdShareThreshold,
  token: env.matcherProviderToken || undefined,
});

Bun.serve({
  port: env.matcherProviderPort,
  fetch: (request) => app.handle(request),
});

console.log(`merkl matcher provider listening on ${env.matcherProviderPort}`);
