import { loadEnv } from "@/config/env";
import { createAppAsync } from "@/app";

const env = loadEnv();
const app = await createAppAsync();

Bun.serve({
  hostname: process.env.PNLX_API_HOST ?? "0.0.0.0",
  port: env.port,
  fetch: (request) => app.handle(request),
});

console.log(`pnlx server listening on ${env.port}`);
