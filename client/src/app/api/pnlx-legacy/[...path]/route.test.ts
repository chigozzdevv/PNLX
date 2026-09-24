/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import type { NextRequest } from "next/server";
import { GET } from "./route";

const originalFetch = globalThis.fetch;
const originalLegacyUrl = process.env.PNLX_LEGACY_API_URL;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalLegacyUrl === undefined) delete process.env.PNLX_LEGACY_API_URL;
  else process.env.PNLX_LEGACY_API_URL = originalLegacyUrl;
});

const request = {
  method: "GET",
  headers: new Headers({ authorization: "Bearer old-session" }),
  nextUrl: new URL("https://www.pnl.family/api/pnlx-legacy/portfolio?ownerCommitment=0x123"),
} as NextRequest;
const context = { params: Promise.resolve({ path: ["portfolio"] }) };

test("previous positions fail closed until the old API is configured", async () => {
  delete process.env.PNLX_LEGACY_API_URL;
  globalThis.fetch = (async () => { throw new Error("must not fetch"); }) as unknown as typeof fetch;
  const response = await GET(request, context);
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "Trading service temporarily unavailable" });
});

test("previous positions use their own backend and keep the wallet session header", async () => {
  process.env.PNLX_LEGACY_API_URL = "http://127.0.0.1:4002";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe("http://127.0.0.1:4002/portfolio?ownerCommitment=0x123");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer old-session");
    return Response.json({ positions: [] });
  }) as unknown as typeof fetch;
  const response = await GET(request, context);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ positions: [] });
});
