/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { groupPositionRows, positionLegs } from "@/lib/position-groups";
import type { Hex, PositionRow } from "@/types/trading";

describe("logical position groups", () => {
  test("aggregates multiple fills from one order into one UI row", () => {
    const first = position("0x11", 55.379063, 1, 0.18057, 100);
    const second = position("0x22", 55.379063, 1, 0.18057, 101);
    const [group] = groupPositionRows([second, first]);

    expect(group).toMatchObject({
      id: "position-group:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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
});

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
  };
}
