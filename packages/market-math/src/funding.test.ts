import { describe, expect, test } from "bun:test";
import { PRICE_SCALE } from "./constants";
import { fundingIndexDelta, fundingPayment } from "./funding";

describe("funding precision", () => {
  test("does not truncate realistic funding for sub-dollar markets", () => {
    expect(fundingIndexDelta({
      elapsedMs: 3_600_000,
      intervalMs: 3_600_000,
      markPrice: 19_775_000n,
      premiumRate: 1_000n,
    })).toBe(19_775n);
  });

  test("converts a price-scaled funding index into collateral units", () => {
    expect(fundingPayment(10_000_000n, 50n * PRICE_SCALE, 0n)).toBe(500_000_000n);
  });
});
