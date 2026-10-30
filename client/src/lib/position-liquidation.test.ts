import { describe, expect, test } from "bun:test";
import { estimatePositionLiquidation, positionLiquidationDisplay } from "./position-liquidation";
import type { MarketDisplay, PositionRow } from "@/types/trading";

const market = { marketId: "xlm-usd-perp", fundingIndex: "0", maintenanceMarginRate: 0.1 };
const now = 1_800_000_000_000;
const priceScale = 100_000_000;

describe("position liquidation estimates", () => {
  test("finds the first distressed short tick using strict maintenance equality", () => {
    // Size=1 price-scale: p109 => equity11/maintenance10; p110 => equity10/maintenance11.
    expect(estimatePositionLiquidation(fill(), market)).toEqual({ status: "price", price: 110 / priceScale });
  });

  test("applies signed funding credits and debits, including a genuine zero index", () => {
    expect(estimatePositionLiquidation(fill(), { ...market, fundingIndex: "5" }))
      .toEqual({ status: "price", price: 115 / priceScale });
    expect(estimatePositionLiquidation(fill(), { ...market, fundingIndex: "-5" }))
      .toEqual({ status: "price", price: 106 / priceScale });
    expect(estimatePositionLiquidation(fill(), market).status).toBe("price");
  });

  test("uses committed net margin without deducting entry fees or rebates again", () => {
    const position = fill();
    for (const entryFee of ["1000", "-1000"]) {
      expect(estimatePositionLiquidation({ ...position, privateState: { ...position.privateState!, entryFee } }, market))
        .toEqual({ status: "price", price: 110 / priceScale });
    }
  });

  test("preserves zero-equity liquidation when rounded maintenance is zero without inventing a zero price", () => {
    const result = estimatePositionLiquidation(fill({ size: "1", entryPrice: "1", margin: "0" }), market);
    expect(result).toEqual({ status: "price", price: 1 / priceScale });
    expect(positionLiquidationDisplay(fill({ size: "1", entryPrice: "1", margin: "0" }), market).value)
      .toBe("$0.00000001");
  });

  test("keeps long values explicitly approximate rather than assuming rounded risk is globally monotone", () => {
    // The continuous long boundary is 88.888... ticks; actual p88 is healthy and p87 distressed.
    expect(estimatePositionLiquidation(fill({ side: "long" }), market))
      .toEqual({ status: "price", price: 89 / priceScale });
    // At tiny sizes the real predicate can alternate healthy/distressed/healthy at neighboring ranges.
    expect(estimatePositionLiquidation(fill({ side: "long", size: "1", entryPrice: "4400000000", margin: "5" }),
      { ...market, maintenanceMarginRate: 0.05 }))
      .toEqual({ status: "price", price: 41.05263158 });
    expect(estimatePositionLiquidation(fill({ side: "long", margin: "100" }), market)).toEqual({ status: "none" });
    expect(positionLiquidationDisplay(fill({ side: "long", margin: "100" }), market).value).toBe("—");
  });

  test("uses the verified funding snapshot and rejects stale or unavailable risk instead of falling back", () => {
    const riskFunding: NonNullable<MarketDisplay["riskFunding"]> = {
      status: "available", source: "onchain-market", fundingIndex: "-5", updatedAt: now,
    };
    expect(estimatePositionLiquidation(fill(), { ...market, riskFunding }, now))
      .toEqual({ status: "price", price: 106 / priceScale });
    for (const snapshot of [{ ...riskFunding, updatedAt: now - 60_001 },
      { ...riskFunding, status: "unavailable" as const, fundingIndex: null }]) {
      expect(estimatePositionLiquidation(fill(), { ...market, riskFunding: snapshot }, now)).toEqual({ status: "unavailable" });
    }
    expect(estimatePositionLiquidation(fill(), { ...market, riskFunding: null } as unknown as MarketDisplay, now))
      .toEqual({ status: "unavailable" });
  });

  test("selects the nearest independent fill risk instead of pooling collateral", () => {
    const first = fill(), second = fill({ margin: "10" });
    expect(estimatePositionLiquidation({ ...first, positionLegs: [first, second] }, market))
      .toEqual({ status: "price", price: 101 / priceScale });
    const long = fill({ side: "long" }), lowerMargin = fill({ side: "long", margin: "10" });
    expect(estimatePositionLiquidation({ ...long, positionLegs: [long, lowerMargin] }, market))
      .toEqual({ status: "price", price: 100 / priceScale });
    expect(estimatePositionLiquidation({ ...first, positionLegs: [first, { ...second, privateState: undefined }] }, market))
      .toEqual({ status: "unavailable" });
  });

  test("returns unknown for missing or invalid position/configuration values", () => {
    for (const position of [{ ...fill(), privateState: undefined }, fill({ size: "0" }), fill({ margin: "-1" }),
      fill({ fundingIndex: "" }), fill({ entryPrice: "NaN" })]) {
      expect(estimatePositionLiquidation(position, market)).toEqual({ status: "unavailable" });
    }
    for (const config of [undefined, { ...market, marketId: "other" }, { ...market, maintenanceMarginRate: NaN },
      { ...market, maintenanceMarginRate: 1e308 }, { ...market, fundingIndex: "not-an-index" }]) {
      expect(estimatePositionLiquidation(fill(), config)).toEqual({ status: "unavailable" });
    }
  });
});

function fill(overrides: Partial<NonNullable<PositionRow["privateState"]>> = {}): PositionRow {
  return {
    batchId: "test", closePrice: null, id: "0x01", marketId: market.marketId, market: "XLM/USD", openedAt: 1,
    sourceIntentCommitment: "0x02", time: "", status: "open",
    privateState: { size: "100000000", entryPrice: "100", margin: "20", side: "short", fundingIndex: "0",
      positionNullifier: "0x03", sourceIntentCommitment: "0x02", ...overrides },
  };
}
