/// <reference types="bun" />

import { afterEach, describe, expect, test } from "bun:test";
import { cancelOrderGroup } from "@/lib/order-cancel";
import { groupOwnerOrders } from "@/lib/order-groups";
import type { Hex, ServerOwnerOrderSnapshot } from "@/types/trading";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("grouped order cancellation", () => {
  test("cancels every active fragment, retaining note links and completed fills", async () => {
    const first = order("11");
    const residual = { ...order("22"), isResidual: true, sourceIntentCommitment: first.intentCommitment };
    const filled = { ...order("33"), status: "filled" as const };
    const [group] = groupOwnerOrders([first, residual, filled]);
    const requested: Hex[] = [];
    mockCancellation((intentCommitment) => {
      requested.push(intentCommitment);
      return { order: { intentCommitment, status: "cancelled" } };
    });

    const result = await cancelOrderGroup({ group });
    expect(result.error).toBeUndefined();
    expect(requested).toEqual([first.intentCommitment, residual.intentCommitment]);
    expect(result.cancelled).toEqual([
      { intentCommitment: first.intentCommitment, noteNullifier: first.noteNullifier, sourceIntentCommitment: undefined },
      { intentCommitment: residual.intentCommitment, noteNullifier: residual.noteNullifier, sourceIntentCommitment: first.intentCommitment },
    ]);
  });

  test("only returns confirmed cancellations when a later fragment fails", async () => {
    const first = order("11");
    const [group] = groupOwnerOrders([first, order("22"), order("33")]);
    let requests = 0;
    mockCancellation((intentCommitment) => {
      requests += 1;
      if (requests === 2) throw new Error("Relay unavailable");
      return { order: { intentCommitment, status: "cancelled" } };
    });

    const result = await cancelOrderGroup({ group });
    expect(requests).toBe(2);
    expect(result.cancelled.map((item) => item.intentCommitment)).toEqual([first.intentCommitment]);
    expect(result.error?.message).toContain("Cancelled 1 of 3");
  });

  test("does not release an order when the API still reports it open", async () => {
    const [group] = groupOwnerOrders([order("11")]);
    mockCancellation((intentCommitment) => ({ order: { intentCommitment, status: "open" } }));

    const result = await cancelOrderGroup({ group });
    expect(result.cancelled).toEqual([]);
    expect(result.error?.message).toContain("Cancellation is not confirmed yet");
  });

  test("rejects confirmation for a different order", async () => {
    const [group] = groupOwnerOrders([order("11")]);
    mockCancellation(() => ({ order: { intentCommitment: order("22").intentCommitment, status: "cancelled" } }));

    const result = await cancelOrderGroup({ group });
    expect(result.cancelled).toEqual([]);
    expect(result.error?.message).toBe("Cancellation returned a different private order");
  });
});

function mockCancellation(respond: (intentCommitment: Hex) => unknown) {
  globalThis.fetch = Object.assign(async (_request: RequestInfo | URL, init?: RequestInit) => {
    const { intentCommitment } = JSON.parse(String(init?.body)) as { intentCommitment: Hex };
    return Response.json(respond(intentCommitment));
  }, { preconnect: originalFetch.preconnect });
}

function order(byte: string): ServerOwnerOrderSnapshot {
  return {
    batchId: `ui-1787329437845-xlm-usd-perp-${Number.parseInt(byte, 16)}`,
    createdAt: 100,
    intentCommitment: `0x${byte.repeat(32)}`,
    isResidual: false,
    marketId: "xlm-usd-perp",
    matching: { message: "Settlement delayed.", state: "blocked" },
    matchingPayloadCommitment: "0x0",
    noteNullifier: `0x${byte.repeat(32)}`,
    status: "open",
    updatedAt: 100,
  };
}
