/// <reference types="bun" />

import { afterEach, describe, expect, test } from "bun:test";
import { pnlxGet, pnlxPost } from "./pnlx-api";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function mockResponse(response: Response) {
  globalThis.fetch = (async () => response) as unknown as typeof fetch;
}

describe("PNLX API errors", () => {
  test.each([502, 503, 504, 200])("hides gateway HTML with status %s", async (status) => {
    mockResponse(new Response("<!DOCTYPE html><html>Cloudflare gateway error</html>", {
      status,
      headers: { "content-type": "text/html" },
    }));
    await expect(pnlxGet("/markets")).rejects.toThrow("Trading service temporarily unavailable");
  });

  test("hides HTML even when the content type is incorrectly JSON", async () => {
    mockResponse(new Response("<!DOCTYPE html><html>Bad gateway</html>", {
      status: 502,
      headers: { "content-type": "application/json" },
    }));
    await expect(pnlxGet("/health")).rejects.toThrow("Trading service temporarily unavailable");
  });

  test("hides HTML wrapped in a JSON error", async () => {
    mockResponse(Response.json({ error: "<html>Bad gateway</html>" }, { status: 502 }));
    await expect(pnlxGet("/health")).rejects.toThrow("Trading service temporarily unavailable");
  });

  test("keeps actionable API validation messages", async () => {
    mockResponse(Response.json({ error: "Insufficient USDC balance for private margin" }, { status: 400 }));
    await expect(pnlxPost("/notes", {})).rejects.toThrow("Insufficient USDC balance for private margin");
  });

  test("normalizes network failures without retrying a submission", async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    await expect(pnlxPost("/intents", {})).rejects.toThrow("Trading service temporarily unavailable");
    expect(requests).toBe(1);
  });

  test("returns successful JSON data", async () => {
    mockResponse(Response.json({ markets: [{ marketId: "xlm-usd-perp" }] }));
    expect(await pnlxGet<{ markets: { marketId: string }[] }>("/markets"))
      .toEqual({ markets: [{ marketId: "xlm-usd-perp" }] });
  });
});
