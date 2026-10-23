/// <reference types="bun" />

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  conditionalOrderCommitment,
  inheritPendingConditionalStrategy,
  registerPendingConditionalOrdersForPosition,
  storePendingConditionalStrategy,
  type PendingConditionalStrategy,
  type PrivatePositionOpeningEvent,
} from "@/lib/conditional-orders";
import { commitConditionalOrder } from "@pnlx/crypto";
import { setPrivateMarginNoteRuntimeScope } from "@/lib/private-margin-notes";
import type { WalletSession } from "@/lib/wallet-auth";
import type { Hex } from "@/types/trading";

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const key = "pnlx.private.conditional-strategies";
const scope = "test:conditional-registrations";
const source = hex("11");
const session: WalletSession = { address: "GTEST", expiresAt: Date.now() + 60_000, ownerCommitment: hex("22"), token: "test" };
let storage: MemoryStorage;
let calls: Array<{ closeCommitment: Hex; marketId: string; positionNullifier: Hex }>;

beforeEach(() => {
  storage = new MemoryStorage();
  calls = [];
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    dispatchEvent: () => true, localStorage: storage, sessionStorage: new MemoryStorage(),
  } });
  setPrivateMarginNoteRuntimeScope(scope);
  storePolicy();
  mockRegistration((body) => Response.json({ conditionalOrder: body }));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  setPrivateMarginNoteRuntimeScope(undefined);
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

describe("private conditional protection", () => {
  test("matches the server's public market binding for both trigger kinds", async () => {
    for (const kind of ["take-profit", "stop-loss"] as const) {
      const input = { kind, marketId: "xlm-usd-perp", positionNullifier: hex("11"), reduceOnly: true,
        salt: "private-base:position:nullifier", side: "short" as const, size: 100n, triggerPrice: 90n };
      expect(await conditionalOrderCommitment(input)).toBe(commitConditionalOrder({ ...input, markPrice: 100n }));
    }
  });
  test("protects every position from one intent and does not re-register replayed events", async () => {
    const first = await registerPendingConditionalOrdersForPosition(session, position("33"));
    const second = await registerPendingConditionalOrdersForPosition(session, position("44"));
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    expect(calls).toHaveLength(4);
    expect(new Set(calls.map((call) => call.closeCommitment)).size).toBe(4);
    expect(await registerPendingConditionalOrdersForPosition(session, position("33"))).toEqual([]);
    expect(calls).toHaveLength(4);
    expect(Object.keys(policies()[0].protections ?? {})).toHaveLength(2);
  });

  test("deduplicates simultaneous syncs for the same position", async () => {
    const results = await Promise.all([
      registerPendingConditionalOrdersForPosition(session, position("33")),
      registerPendingConditionalOrdersForPosition(session, position("33")),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(calls).toHaveLength(2);
  });

  test("merges simultaneous distinct positions without losing their protection state", async () => {
    await Promise.all([
      registerPendingConditionalOrdersForPosition(session, position("33")),
      registerPendingConditionalOrdersForPosition(session, position("44")),
    ]);
    const protections = Object.values(policies()[0].protections ?? {});
    expect(protections).toHaveLength(2);
    expect(protections.every((protection) => protection.registrations.every((entry) => entry.status === "registered"))).toBe(true);
    expect(calls).toHaveLength(4);
  });

  test("persists both commitments before relay and retries only the failed trigger", async () => {
    let failed = false;
    mockRegistration((body) => {
      const prepared = policies()[0].protections?.[position("33").positionCommitment];
      expect(prepared?.registrations).toHaveLength(2);
      if (calls.length === 2 && !failed) {
        failed = true;
        return Response.json({ error: "relay unavailable" }, { status: 503 });
      }
      return Response.json({ conditionalOrder: body });
    });
    await expect(registerPendingConditionalOrdersForPosition(session, position("33"))).rejects.toThrow("relay unavailable");
    const failedCommitment = calls[1].closeCommitment;
    expect(policies()[0].protections?.[hex("33")]?.registrations.map((entry) => entry.status)).toEqual(["registered", "pending"]);
    const retried = await registerPendingConditionalOrdersForPosition(session, position("33"));
    expect(retried).toHaveLength(1);
    expect(calls).toHaveLength(3);
    expect(calls[2].closeCommitment).toBe(failedCommitment);
  });

  test("an ambiguous relay response keeps the same commitment for reconciliation", async () => {
    let fail = true;
    mockRegistration((body) => {
      if (fail) {
        fail = false;
        throw new Error("response lost after acceptance");
      }
      return Response.json({ conditionalOrder: body });
    });
    await expect(registerPendingConditionalOrdersForPosition(session, position("33"))).rejects.toThrow("temporarily unavailable");
    const acceptedCommitment = calls[0].closeCommitment;
    await registerPendingConditionalOrdersForPosition(session, position("33"));
    expect(calls[1].closeCommitment).toBe(acceptedCommitment);
    expect(calls).toHaveLength(3);
  });

  test("inherits protection for residual fills after the original intent was already registered", async () => {
    await registerPendingConditionalOrdersForPosition(session, position("33"));
    const residual = { intentCommitment: hex("55"), sourceIntentCommitment: source, marketId: "xlm-usd-perp", ownerCommitment: session.ownerCommitment };
    expect(inheritPendingConditionalStrategy(session, residual)).toBe(true);
    expect(inheritPendingConditionalStrategy(session, residual)).toBe(false);
    expect(await registerPendingConditionalOrdersForPosition(session, position("66", residual.intentCommitment))).toHaveLength(2);
    expect(calls).toHaveLength(4);
    expect(policies()).toHaveLength(2);
    expect(policies()[1].stopLossPrice).toBe(policies()[0].stopLossPrice);
  });

  test("does not inherit another owner's policy or send a strategy from a different runtime", async () => {
    expect(inheritPendingConditionalStrategy(session, {
      intentCommitment: hex("55"), sourceIntentCommitment: source,
      marketId: "xlm-usd-perp", ownerCommitment: hex("99"),
    })).toBe(false);
    setPrivateMarginNoteRuntimeScope("test:another-deployment");
    expect(await registerPendingConditionalOrdersForPosition(session, position("33"))).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test("does not mark protection registered when the server confirms another position", async () => {
    mockRegistration((body) => Response.json({ conditionalOrder: { ...body, positionNullifier: hex("ff") } }));
    await expect(registerPendingConditionalOrdersForPosition(session, position("33"))).rejects.toThrow("does not match");
    expect(policies()[0].protections?.[hex("33")]?.registrations.every((entry) => entry.status === "pending")).toBe(true);
  });

  test("keeps legacy intent-level registered policies active for additional positions", async () => {
    const legacy = policies()[0];
    delete legacy.runtimeScope;
    legacy.status = "registered";
    storage.setItem(key, JSON.stringify([legacy]));
    expect(await registerPendingConditionalOrdersForPosition(session, position("33"))).toHaveLength(2);
  });
});

function storePolicy(): void {
  storePendingConditionalStrategy({
    entryLimitPrice: "100", intentCommitment: source, leverage: 2, margin: "1000", marketId: "xlm-usd-perp",
    ownerCommitment: session.ownerCommitment, side: "long", size: "100", stopLossPrice: "90", takeProfitPrice: "110",
  });
}

function position(id: string, sourceIntentCommitment = source): PrivatePositionOpeningEvent {
  return { kind: "position-opening", marketId: "xlm-usd-perp", positionCommitment: hex(id),
    positionNullifier: hex((Number.parseInt(id, 16) + 1).toString(16)), side: "long", size: "50", sourceIntentCommitment };
}

function mockRegistration(handle: (body: typeof calls[number]) => Response): void {
  globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as typeof calls[number];
    calls.push(body);
    return handle(body);
  }, { preconnect: originalFetch.preconnect });
}

function policies(): PendingConditionalStrategy[] { return JSON.parse(storage.getItem(key) ?? "[]"); }
function hex(value: string): Hex { return `0x${value.padStart(2, "0").repeat(32)}`; }

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(name: string) { return this.values.get(name) ?? null; }
  setItem(name: string, value: string) { this.values.set(name, value); }
  removeItem(name: string) { this.values.delete(name); }
}
