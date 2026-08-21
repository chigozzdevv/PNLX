/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { groupOwnerOrders, logicalOrderId } from "@/lib/order-groups";
import type { Hex, ServerOwnerOrderSnapshot } from "@/types/trading";

describe("logical owner orders", () => {
  test("groups private-note fragments from one submission into one order", () => {
    const first = order("ui-1787329437845-xlm-usd-perp-1", "11", "open", 100);
    const second = order("ui-1787329437845-xlm-usd-perp-2", "22", "open", 101);

    expect(logicalOrderId(first)).toBe("ui-1787329437845-xlm-usd-perp");
    expect(groupOwnerOrders([second, first])).toMatchObject([{
      activeOrders: [{ intentCommitment: first.intentCommitment }, { intentCommitment: second.intentCommitment }],
      id: "ui-1787329437845-xlm-usd-perp",
      status: "open",
    }]);
  });

  test("keeps unrelated and non-UI orders separate", () => {
    const first = order("maker-batch", "11", "open", 100);
    const second = order("maker-batch", "22", "open", 101);

    expect(groupOwnerOrders([first, second]).map((group) => group.id)).toEqual([
      second.intentCommitment,
      first.intentCommitment,
    ]);
  });

  test("shows a partly resolved fragmented order as partially filled", () => {
    const filled = order("ui-1787329437845-xlm-usd-perp-1", "11", "filled", 100);
    const open = order("ui-1787329437845-xlm-usd-perp-2", "22", "open", 101);

    const [group] = groupOwnerOrders([filled, open]);
    expect(group.status).toBe("partially-filled");
    expect(group.activeOrders.map((item) => item.intentCommitment)).toEqual([open.intentCommitment]);
  });

  test("keeps a filled and cancelled submission partially filled", () => {
    const filled = order("ui-1787329437845-xlm-usd-perp-1", "11", "filled", 100);
    const cancelled = order("ui-1787329437845-xlm-usd-perp-2", "22", "cancelled", 101);

    const [group] = groupOwnerOrders([filled, cancelled]);
    expect(group.status).toBe("partially-filled");
    expect(group.activeOrders).toEqual([]);
  });
});

function order(
  batchId: string,
  byte: string,
  status: ServerOwnerOrderSnapshot["status"],
  createdAt: number,
): ServerOwnerOrderSnapshot {
  return {
    batchId,
    createdAt,
    intentCommitment: `0x${byte.repeat(32)}` as Hex,
    isResidual: false,
    marketId: "xlm-usd-perp",
    matching: { message: "Matching", state: "matching" },
    matchingPayloadCommitment: "0x0",
    status,
    updatedAt: createdAt,
  };
}
