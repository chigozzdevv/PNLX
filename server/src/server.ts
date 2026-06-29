import { loadEnv } from "./config/env";
import { createApp } from "./app";

const env = loadEnv();
const app = createApp();

Bun.serve({
  port: env.port,
  fetch: (request) => app.handle(request),
});

console.log(`merkl server listening on ${env.port}`);
