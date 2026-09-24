import { expect, test } from "bun:test";
import { browserCors, webOrigins } from "./cors";

const handle = browserCors(
  () => Response.json({ ok: true }),
  webOrigins("https://www.pnl.family"),
);

test("permits browser preflight and exposes API responses to the PNLX site", async () => {
  const preflight = await handle(new Request("https://api.pnl.family/intents", {
    method: "OPTIONS",
    headers: {
      origin: "https://www.pnl.family",
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization, content-type",
    },
  }));
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("access-control-allow-origin")).toBe("https://www.pnl.family");
  expect(preflight.headers.get("access-control-allow-headers")).toContain("authorization");

  const response = await handle(new Request("https://api.pnl.family/health", {
    headers: { origin: "https://www.pnl.family" },
  }));
  expect(response.status).toBe(200);
  expect(response.headers.get("access-control-allow-origin")).toBe("https://www.pnl.family");
});

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
