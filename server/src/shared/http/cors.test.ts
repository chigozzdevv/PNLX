import { expect, test } from "bun:test";
import { browserCors, DEFAULT_PRODUCTION_WEB_ORIGINS, webOrigins } from "./cors";

const handle = browserCors(
  () => Response.json({ ok: true }),
  webOrigins(DEFAULT_PRODUCTION_WEB_ORIGINS),
);

test.each(["https://pnlx.trade", "https://www.pnlx.trade", "https://www.pnl.family", "https://pnl.family"])(
  "permits browser preflight and API responses for %s on both API domains", async (origin) => {
    for (const api of ["https://api.pnlx.trade", "https://api.pnl.family"]) {
      const preflight = await handle(new Request(`${api}/intents`, {
        method: "OPTIONS",
        headers: {
          origin,
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization, content-type",
        },
      }));
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe(origin);
      expect(preflight.headers.get("access-control-allow-headers")).toContain("authorization");

      const response = await handle(new Request(`${api}/health`, {
        headers: { origin },
      }));
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    }
  },
);

test("does not grant cross-origin access to other sites", async () => {
  const preflight = await handle(new Request("https://api.pnl.family/intents", {
    method: "OPTIONS",
    headers: { origin: "https://elsewhere.example", "access-control-request-method": "POST" },
  }));
  expect(preflight.status).toBe(403);
  const response = await handle(new Request("https://api.pnl.family/health", {
    headers: { origin: "https://elsewhere.example" },
  }));
  expect(response.headers.has("access-control-allow-origin")).toBe(false);
});
