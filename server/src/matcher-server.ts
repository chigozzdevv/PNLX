import { loadEnv } from "@/config/env";
import { createMatcherApp } from "@/workers/matcher/matcher.app";

const env = loadEnv();
const app = createMatcherApp({
  computeBackend: env.matcherComputeBackend,
  computeToken: env.matcherComputeToken || undefined,
  computeUrl: env.matcherComputeUrl || undefined,
  nilccAttestationContains: env.nilccAttestationContains,
  nilccAttestationReportSha256: env.nilccAttestationReportSha256 || undefined,
  nilccAttestationReportUrl: env.nilccAttestationReportUrl || undefined,
  nilccAttestationRequired: env.nilccAttestationRequired,
  nilccAttestationToken: env.nilccAttestationToken || undefined,
  nilccWorkloadUrl: env.nilccWorkloadUrl || undefined,
  thresholdShareNodeIds: env.thresholdShareNodeIds,
  thresholdShareStoreDir: env.thresholdShareStoreDir || undefined,
  thresholdShareThreshold: env.thresholdShareThreshold,
  privateMatchingRequired: env.privateMatchingRequired,
  storePath: env.protocolStorePath || undefined,
  token: env.matcherApiToken,
});
const port = env.matcherPort;

Bun.serve({
  port,
  fetch: (request) => app.handle(request),
});

console.log(`merkl matcher listening on ${port}`);
