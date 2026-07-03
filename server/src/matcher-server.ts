import { loadEnv } from "@/config/env";
import { createMatcherAppAsync } from "@/workers/matcher/matcher.app";

const env = loadEnv();
if (env.protocolStorageDriver === "mongodb" && !env.mongodbUri) {
  throw new Error("MONGODB_URI is required when PROTOCOL_STORAGE_DRIVER=mongodb");
}
const mongo = env.protocolStorageDriver === "mongodb"
  ? {
      collection: env.mongodbCollection,
      database: env.mongodbDatabase,
      documentId: env.stellarNetwork,
      uri: env.mongodbUri,
    }
  : undefined;
const app = await createMatcherAppAsync({
  mongo,
  provider: env.matcherProvider,
  privateMatchingRequired: env.privateMatchingRequired,
  storePath: env.protocolStorageDriver === "file" ? env.protocolStorePath || undefined : undefined,
  token: env.matcherApiToken,
});
const port = env.matcherPort;
const hostname = process.env.MATCHER_HOST ?? "127.0.0.1";

Bun.serve({
  hostname,
  port,
  fetch: (request) => app.handle(request),
});

console.log(`pnlx matcher listening on ${hostname}:${port}`);
