import { afterEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { POST } from "./route";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const context = { params: Promise.resolve({ path: ["intent-validity"] }) };

describe("client prover proxy", () => {
  test("propagates a browser disconnect to the pending upstream request without retrying", async () => {
    const controller = new AbortController();
    const request = new NextRequest("http://client/api/prover/intent-validity", {
      method: "POST", body: "{}", signal: controller.signal,
    });
    let started!: () => void;
    const upstreamStarted = new Promise<void>((resolve) => { started = resolve; });
    let upstreamCancelled = false;
    let requests = 0;
    globalThis.fetch = (async (_target: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requests += 1;
      const signal = init?.signal;
      expect(signal).toBe(request.signal);
      started();
      return new Promise<Response>((_resolve, reject) => {
        signal!.addEventListener("abort", () => {
          upstreamCancelled = true;
          reject(new DOMException("Cancelled", "AbortError"));
        }, { once: true });
      });
    }) as unknown as typeof fetch;

    const response = POST(request, context);
    await upstreamStarted;
    controller.abort();
    await response;
    expect(upstreamCancelled).toBe(true);
    expect(requests).toBe(1);
  });

  test("keeps overload status and Retry-After from the upstream prover", async () => {
    const error = { error: "Prover is busy. Try again shortly." };
    globalThis.fetch = (async () => Response.json(error, {
      status: 503, headers: { "retry-after": "1", "cache-control": "no-store" },
    })) as unknown as typeof fetch;
    const response = await POST(new NextRequest("http://client/api/prover/intent-validity", {
      method: "POST", body: "{}",
    }), context);

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual(error);
  });
});
