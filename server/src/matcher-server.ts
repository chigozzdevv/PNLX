import { loadEnv } from "@/config/env";
import { createMatcherAppAsync } from "@/workers/matcher/matcher.app";

const env = loadEnv();
const app = await createMatcherAppAsync({
  mongo: {
    collection: env.mongodbCollection,
    database: env.mongodbDatabase,
    documentId: env.stellarNetwork,
    uri: env.mongodbUri,
  },
  provider: env.matcherProvider,
  privateMatchingRequired: env.privateMatchingRequired,
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
