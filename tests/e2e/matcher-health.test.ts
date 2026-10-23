import { describe, expect, test } from "bun:test";
import { loadEnv } from "@/config/env";
import { registerHealthRoute } from "@/features/health/health.route";
import { Router } from "@/shared/http/router";
import { createExecutor } from "@/workers/executor/executor.worker";
import { createMatcherApp, createMatcherAppAsync } from "@/workers/matcher/matcher.app";

describe("matcher health", () => {
  for (const [name, create] of [
    ["synchronous", createMatcherApp],
    ["asynchronous", createMatcherAppAsync],
  ] as const) {
    test(`${name} app observes liveness without executing a proof or changing orders`, async () => {
      const executor = createExecutor();
      const app = await create({ executor, token: "internal-matcher-token" });
      const response = await app.handle(new Request("http://matcher.local/health", {
        headers: { authorization: "Bearer internal-matcher-token" },
      }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: true,
        service: "pnlx-matcher",
        scope: "service-liveness",
        proofExecutionChecked: false,
      });
      expect(executor.store.intents.size).toBe(0);
      expect(executor.store.settlements.size).toBe(0);
      expect(executor.store.proofs.size).toBe(0);

      const unauthorized = await app.handle(new Request("http://matcher.local/health"));
      expect(unauthorized.ok).toBe(false);
      expect(await unauthorized.text()).not.toContain("internal-matcher-token");
    });
  }

  test("API live dependency check reaches the real authenticated matcher health route", async () => {
    const matcher = await createMatcherAppAsync({ token: "matcher-health-token" });
    const api = new Router();
    const env = {
      ...loadEnv(),
      mongodbUri: "",
      oracleOnchainRequired: false,
      settlementsOnchainRequired: false,
      privateMatchingRequired: true,
      matcherServiceUrl: "http://matcher.local",
      matcherServiceToken: "matcher-health-token",
    };
    registerHealthRoute(api, env);
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request.url);
      return matcher.handle(request);
    }) as typeof fetch;
    try {
      const response = await api.handle(new Request("http://api.local/health/live"));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        scope: "dependency-observation",
        checks: { matcher: { ok: true }, persistence: { ok: true } },
        verifierAuthorityChecked: false,
      });
      expect(requests).toEqual(["http://matcher.local/health"]);

      env.matcherServiceToken = "incorrect-token";
      const denied = await api.handle(new Request("http://api.local/health/live"));
      expect(denied.status).toBe(503);
      expect(await denied.json()).toMatchObject({ ok: false, checks: { matcher: { ok: false } } });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
