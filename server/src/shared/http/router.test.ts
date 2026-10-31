import { describe, expect, test } from "bun:test";
import { Router } from "./router";
import { StaleMarginRootError } from "@/shared/protocol/stale-margin-root.error";

describe("HTTP conflict responses", () => {
  test("returns stale margin roots as typed conflicts", async () => {
    const router = new Router();
    router.add("POST", "/intents", () => { throw new StaleMarginRootError(); });

    const response = await router.handle(new Request("https://pnlx.test/intents", { method: "POST" }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "intent margin root is not current", code: "STALE_MARGIN_ROOT" });
  });
});
