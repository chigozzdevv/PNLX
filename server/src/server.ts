import { loadEnv } from "@/config/env";
import { createAppRuntimeAsync } from "@/app";
import { browserCors, webOrigins } from "@/shared/http/cors";

const env = loadEnv();
const app = await createAppRuntimeAsync();
app.liquidityHistory?.start();
const allowedOrigins = webOrigins(process.env.PNLX_WEB_ORIGINS ?? (
  process.env.NODE_ENV === "production"
    ? "https://www.pnl.family"
    : "http://localhost:3000,http://127.0.0.1:3000"
));

Bun.serve({
  hostname: process.env.PNLX_API_HOST ?? "0.0.0.0",
  port: env.port,
  fetch: browserCors((request) => app.router.handle(request), allowedOrigins),
});

console.log(`pnlx server listening on ${env.port}`);
