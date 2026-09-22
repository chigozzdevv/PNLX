/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import type { NextRequest } from "next/server";
import { GET } from "./route";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const request = {
  method: "GET",
  headers: new Headers(),
  nextUrl: new URL("https://www.pnl.family/api/pnlx/markets"),
} as NextRequest;
const context = { params: Promise.resolve({ path: ["markets"] }) };

test("proxy replaces HTML gateway pages with an uncached JSON error", async () => {
  globalThis.fetch = (async () => new Response("<html>Bad gateway</html>", {
    status: 502,
    headers: { "content-type": "text/html" },
  })) as unknown as typeof fetch;
  const response = await GET(request, context);
  expect(response.status).toBe(502);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ error: "Trading service temporarily unavailable" });
});

test("proxy does not expose backend addresses or fetch failure details", async () => {
  globalThis.fetch = (async () => { throw new Error("ECONNREFUSED internal-service:4000"); }) as unknown as typeof fetch;
  const response = await GET(request, context);
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "Trading service temporarily unavailable" });
});

test("proxy preserves useful JSON errors and their status", async () => {
  globalThis.fetch = (async () => Response.json({ error: "Session expired" }, { status: 401 })) as unknown as typeof fetch;
  const response = await GET(request, context);
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "Session expired" });
});
