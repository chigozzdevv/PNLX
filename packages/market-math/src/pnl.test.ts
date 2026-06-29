import { describe, expect, test } from "bun:test";
import { PRICE_SCALE } from "./constants";
import { settleClose } from "./pnl";

describe("close settlement", () => {
  test("subtracts funding debits from margin", () => {
    const settlement = settleClose({
      closeSize: 1n,
      entryPrice: 60_000n * PRICE_SCALE,
      fee: 5n,
      fundingPayment: 10n,
      margin: 1_000n,
      markPrice: 60_000n * PRICE_SCALE,
      side: "long",
    });

    expect(settlement.newMargin).toBe(985n);
  });

  test("adds funding credits to margin", () => {
    const settlement = settleClose({
      closeSize: 1n,
      entryPrice: 60_000n * PRICE_SCALE,
      fee: 5n,
      fundingPayment: -10n,
      margin: 1_000n,
      markPrice: 60_000n * PRICE_SCALE,
      side: "short",
    });

    expect(settlement.newMargin).toBe(1_005n);
  });
});
