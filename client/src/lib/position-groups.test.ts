/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { groupPositionRows, hasPrivatePositionState, positionLegs, positionSourceOrder } from "@/lib/position-groups";
import type { Hex, PositionRow, ServerOwnerOrderSnapshot } from "@/types/trading";

const SOURCE_A = `0x${"a".repeat(64)}` as Hex;
const SOURCE_B = `0x${"b".repeat(64)}` as Hex;
const SOURCE_C = `0x${"c".repeat(64)}` as Hex;
const UI_GROUP = "ui-1787329437845-xlm-usd-perp";

describe("logical position groups", () => {
  test("aggregates multiple fills from one order into one UI row", () => {
    const first = position("0x11", 55.379063, 1, 0.18057, 100);
    const second = position("0x22", 55.379063, 1, 0.18057, 101);
    const [group] = groupPositionRows([second, first]);

    expect(group).toMatchObject({
      id: `position-group:${SOURCE_A}:xlm-usd-perp:long`,
      market: "XLM/USD",
      side: "long",
      size: 110.758126,
      collateral: 2,
    });
    expect(group.entryPrice).toBeCloseTo(0.18057, 8);
    expect(group.unrealizedPnl).toBeCloseTo(0.29018629012, 10);
    expect(positionLegs(group).map((leg) => leg.id)).toEqual(["0x11", "0x22"]);
  });

  test("does not combine different source orders", () => {
    const first = position("0x11", 5, 1, 0.18, 100);
    const second = position("0x22", 5, 1, 0.18, 101, "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");

    expect(groupPositionRows([first, second])).toHaveLength(2);
  });

  test("groups note fragments across execution batches with a stable one-to-many row identity", () => {
    const first = position("0x11", 1_000, 166.93, 0.18, 100, SOURCE_A);
    const second = position("0x22", 200, 33.36, 0.19, 200, SOURCE_B);
    first.batchId = "execution-a";
    second.batchId = "execution-b";
    first.entryFee = 0.1;
    second.entryFee = -0.01;
    const orders = [order(SOURCE_A, `${UI_GROUP}-1`), order(SOURCE_B, `${UI_GROUP}-2`)];
    const [initial] = groupPositionRows([first], orders);
    const [group] = groupPositionRows([second, first], orders);

    expect(group.id).toBe(initial.id);
    expect(group.id).toBe(`position-group:${UI_GROUP}:xlm-usd-perp:long`);
    expect(positionLegs(initial)).toEqual([first]);
    expect(positionLegs(group)).toEqual([first, second]);
    expect(positionLegs(group)[0]).toBe(first);
    expect(positionLegs(group)[1]).toBe(second);
    expect(group.size).toBe(1_200);
    expect(group.collateral).toBeCloseTo(200.29);
    expect(group.entryFee).toBeCloseTo(0.09);
    expect(group.entryPrice).toBeCloseTo((1_000 * 0.18 + 200 * 0.19) / 1_200);
    expect(group.unrealizedPnl).toBeCloseTo(first.unrealizedPnl! + second.unrealizedPnl!);
    expect(group.privateState).toBeUndefined();
    expect(group.commitment).toBeUndefined();
    expect(hasPrivatePositionState(group)).toBe(true);
  });

  test("never groups independent trades by market or execution batch", () => {
    const first = position("0x11", 5, 1, 0.18, 100, SOURCE_A);
    const second = position("0x22", 5, 1, 0.18, 101, SOURCE_B);
    first.batchId = second.batchId = `${UI_GROUP}-1`;
    const orders = [order(SOURCE_A, `${UI_GROUP}-1`), order(SOURCE_B, "ui-1787329437846-xlm-usd-perp-1")];
    expect(groupPositionRows([first, second], orders)).toHaveLength(2);
    expect(groupPositionRows([first, second])).toHaveLength(2);
  });

  test("keeps opposite sides, unknown sides and different markets separate", () => {
    const first = position("0x11", 5, 1, 0.18, 100, SOURCE_A);
    const second = position("0x22", 5, 1, 0.18, 101, SOURCE_B);
    const orders = [order(SOURCE_A, `${UI_GROUP}-1`), order(SOURCE_B, `${UI_GROUP}-2`)];
    const short = { ...second, side: "short" as const, privateState: { ...second.privateState!, side: "short" as const } };
    expect(groupPositionRows([first, short], orders)).toHaveLength(2);
    expect(groupPositionRows([first, { ...second, side: undefined }], orders)).toHaveLength(2);
    const otherMarket = { ...second, marketId: "btc-usd-perp", market: "BTC/USD" };
    expect(groupPositionRows([first, otherMarket], [orders[0], { ...orders[1], marketId: otherMarket.marketId }])).toHaveLength(2);
    expect(positionSourceOrder(otherMarket, orders)).toBeUndefined();
  });

  test("resolves residual ancestors and case-insensitive commitments to the original UI trade", () => {
    const first = position("0x11", 5, 1, 0.18, 100, SOURCE_A);
    const second = position("0x22", 5, 1, 0.18, 101, SOURCE_C.toUpperCase());
    const original = order(SOURCE_B, `${UI_GROUP}-2`);
    const residual = { ...order(SOURCE_C, "execution-residual"), isResidual: true, sourceIntentCommitment: SOURCE_B };
    const orders = [order(SOURCE_A, `${UI_GROUP}-1`), original, residual];
    const [group] = groupPositionRows([first, second], orders);
    expect(group.positionLegs).toHaveLength(2);
    expect(positionSourceOrder(second, orders)).toBe(original);
    expect(groupPositionRows([first, second], [...orders, { ...original, intentCommitment: SOURCE_B.toUpperCase() as Hex, status: "open" }])).toHaveLength(1);
    const grandchildId = `0x${"d".repeat(64)}` as Hex;
    const grandchild = { ...order(grandchildId, "execution-grandchild"), isResidual: true, sourceIntentCommitment: SOURCE_C };
    const later = position("0x33", 2, 1, 0.18, 102, grandchildId);
    expect(positionSourceOrder(later, [...orders, grandchild])).toBe(original);
    expect(groupPositionRows([first, second, later], [...orders, grandchild])[0].positionLegs).toHaveLength(3);
  });

  test("rejects cyclic, missing and wrong-market residual ancestry", () => {
    const first = position("0x11", 5, 1, 0.18, 100, SOURCE_A);
    const second = position("0x22", 5, 1, 0.18, 101, SOURCE_B);
    const root = order(SOURCE_A, `${UI_GROUP}-1`);
    for (const orders of [
      [root, { ...order(SOURCE_B, "residual"), isResidual: true, sourceIntentCommitment: SOURCE_C }],
      [{ ...root, isResidual: true, sourceIntentCommitment: SOURCE_B }, { ...order(SOURCE_B, "residual"), isResidual: true, sourceIntentCommitment: SOURCE_A }],
      [{ ...root, marketId: "btc-usd-perp" }, { ...order(SOURCE_B, "residual"), isResidual: true, sourceIntentCommitment: SOURCE_A }],
    ]) {
      expect(positionSourceOrder(second, orders)).toBeUndefined();
      expect(groupPositionRows([first, second], orders)).toHaveLength(2);
    }
  });

  test("does not merge ambiguous source records or reused UI fragment identities", () => {
    const first = position("0x11", 5, 1, 0.18, 100, SOURCE_A);
    const second = position("0x22", 5, 1, 0.18, 101, SOURCE_A);
    const original = order(SOURCE_A, `${UI_GROUP}-1`);
    for (const conflicting of [
      { ...original, batchId: "different-original" },
      { ...original, matchingPayloadCommitment: "0x99" as Hex },
    ]) {
      expect(groupPositionRows([first, second], [original, conflicting])).toHaveLength(2);
      expect(positionSourceOrder(first, [original, conflicting])).toBeUndefined();
    }
    const reused = order(SOURCE_B, `${UI_GROUP}-1`);
    expect(positionSourceOrder(first, [original, reused])).toBeUndefined();
    expect(groupPositionRows([first, { ...second, sourceIntentCommitment: SOURCE_B }], [original, reused])).toHaveLength(2);
  });

  test("keeps missing sources and inconsistent private provenance separate", () => {
    const first = position("0x11", 5, 1, 0.18, 100, SOURCE_A);
    const second = position("0x22", 5, 1, 0.18, 101, SOURCE_A);
    const missing = [first, second].map((item) => ({ ...item, sourceIntentCommitment: undefined } as unknown as PositionRow));
    expect(groupPositionRows(missing)).toHaveLength(2);
    const inconsistent = { ...second, privateState: { ...second.privateState!, sourceIntentCommitment: SOURCE_B } };
    expect(groupPositionRows([first, inconsistent], [order(SOURCE_A, `${UI_GROUP}-1`)])).toHaveLength(2);
  });

  test("deduplicates protocol legs when repeated or regrouped without changing their metadata", () => {
    const first = position("0x11", 5, 1, 0.18, 100, SOURCE_A);
    const second = position("0x22", 5, 1, 0.18, 101, SOURCE_B);
    const orders = [order(SOURCE_A, `${UI_GROUP}-1`), order(SOURCE_B, `${UI_GROUP}-2`)];
    const [group] = groupPositionRows([first, second], orders);
    const [again] = groupPositionRows([group, first, { ...second, commitment: second.commitment!.toUpperCase() as Hex }], orders);
    expect(again.id).toBe(group.id);
    expect(positionLegs(again)).toEqual([first, second]);
    expect(again.size).toBe(10);
    expect(groupPositionRows([first])[0]).toBe(first);
  });

  test("keeps aggregate values unknown when a leg is hidden or a numeric input is missing or non-finite", () => {
    const first = position("0x11", 5, 1, 0.18, 100);
    const second = position("0x22", 5, 1, 0.18, 101);
    for (const field of ["size", "collateral", "entryFee", "unrealizedPnl", "netValue"] as const) {
      for (const invalid of [NaN, Infinity]) {
        const [group] = groupPositionRows([first, { ...second, [field]: invalid }]);
        expect(group[field]).toBeUndefined();
      }
    }
    expect(groupPositionRows([first, { ...second, unrealizedPnl: undefined }])[0].unrealizedPnl).toBeUndefined();
    expect(groupPositionRows([first, { ...second, size: undefined }])[0].entryPrice).toBeUndefined();
    expect(groupPositionRows([first, { ...second, entryPrice: Infinity }])[0].entryPrice).toBeUndefined();
    expect(groupPositionRows([first, { ...second, marketPrice: undefined }])[0].marketPrice).toBeUndefined();
    const [hidden] = groupPositionRows([first, { ...second, privateState: undefined, privateDetails: true }]);
    for (const value of [hidden.size, hidden.collateral, hidden.entryFee, hidden.unrealizedPnl, hidden.netValue, hidden.entryPrice]) {
      expect(value).toBeUndefined();
    }
    expect(hasPrivatePositionState(hidden)).toBe(false);
  });

  test("preserves known zero totals and rejects overflowing sums", () => {
    const first = { ...position("0x11", 5, 1, 0.18, 100), unrealizedPnl: 0, entryFee: 0 };
    const second = { ...position("0x22", 5, 1, 0.18, 101), unrealizedPnl: 0 };
    const [group] = groupPositionRows([first, second]);
    expect(group.unrealizedPnl).toBe(0);
    expect(group.entryFee).toBe(0);
    const [overflow] = groupPositionRows([
      { ...first, size: Number.MAX_VALUE, collateral: Number.MAX_VALUE },
      { ...second, size: Number.MAX_VALUE, collateral: Number.MAX_VALUE },
    ]);
    expect(overflow.size).toBeUndefined();
    expect(overflow.collateral).toBeUndefined();
    expect(overflow.entryPrice).toBeUndefined();
  });
});

function order(intentCommitment: Hex, batchId: string): ServerOwnerOrderSnapshot {
  return {
    intentCommitment, batchId, marketId: "xlm-usd-perp", isResidual: false,
    matching: { message: "Settled", state: "settled" }, matchingPayloadCommitment: "0x01",
    createdAt: 1, updatedAt: 2, status: "filled",
  };
}

function position(
  id: string,
  size: number,
  collateral: number,
  entryPrice: number,
  openedAt: number,
  sourceIntentCommitment = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
): PositionRow {
  return {
    batchId: "batch",
    closePrice: null,
    collateral,
    commitment: id as Hex,
    entryPrice,
    id,
    market: "XLM/USD",
    marketId: "xlm-usd-perp",
    marketPrice: 0.18319,
    openedAt,
    privateState: {
      entryPrice: "18057000",
      fundingIndex: "0",
      margin: `${collateral * 10_000_000}`,
      positionNullifier: `0x${id.slice(2).padEnd(64, "0")}` as Hex,
      side: "long",
      size: `${Math.round(size * 100_000_000)}`,
      sourceIntentCommitment: sourceIntentCommitment as Hex,
    },
    side: "long",
    size,
    sourceIntentCommitment: sourceIntentCommitment as Hex,
    status: "open",
    time: "",
    unrealizedPnl: (0.18319 - entryPrice) * size,
    netValue: collateral + (0.18319 - entryPrice) * size,
  };
}
