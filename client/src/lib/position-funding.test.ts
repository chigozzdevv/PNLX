import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PositionCloseDialog } from "@/components/position-close-dialog";
import { currentPositionFundingIndex, positionFundingPayment, positionValuation } from "@/lib/position-funding";
import { groupPositionRows, positionLegs } from "@/lib/position-groups";
import { applyLatestOnchainMarks, applyMarketSummaries } from "@/lib/use-trading-data";
import type { MarketDisplay, PositionRow, ServerMarketConfig, TradingLiveData } from "@/types/trading";

const now = 1_000_000;
const opening: NonNullable<PositionRow["privateState"]> = {
  size: "1000000000", side: "long", entryPrice: "20000000", margin: "990000000", entryFee: "10000000",
  fundingIndex: "0", positionNullifier: "0x01", sourceIntentCommitment: "0x02",
};
const market = { marketId: "xlm-usd-perp", fundingIndex: "999", riskFunding: {
  status: "available", source: "onchain-market", fundingIndex: "2000000", updatedAt: now,
} } as MarketDisplay;
const summary = { marketId: market.marketId, oraclePrice: "20000000", maxLeverage: "10", initialMarginRate: "100000",
  maintenanceMarginRate: "50000", fundingIndex: "999", riskFunding: market.riskFunding } as ServerMarketConfig;
function row(id = "position"): PositionRow {
  return { id, batchId: "batch", marketId: market.marketId, market: "XLM/USD", status: "open", openedAt: 1,
    time: "00:00", side: "long", collateral: 99, entryFee: 1, size: 100, entryPrice: 0.2, closePrice: null,
    commitment: id as `0x${string}`, sourceIntentCommitment: "0x02", privateState: opening };
}
function data(): TradingLiveData {
  return { markets: [market], positions: [row()], orders: [], activity: [], ticker: [] } as unknown as TradingLiveData;
}

describe("position funding accrual", () => {
  test("uses signed settled-index deltas for each side, including credits and zero", () => {
    expect(positionFundingPayment(opening, market, now)).toBe(20_000_000n);
    expect(positionFundingPayment({ ...opening, side: "short" }, market, now)).toBe(-20_000_000n);
    expect(positionFundingPayment({ ...opening, fundingIndex: "3000000" }, market, now)).toBe(-10_000_000n);
    expect(positionFundingPayment(opening, { fundingIndex: "-2000000" }, now)).toBe(-20_000_000n);
    expect(positionFundingPayment(opening, { fundingIndex: "0" }, now)).toBe(0n);
    expect(positionFundingPayment({ ...opening, size: "1" }, { fundingIndex: "-1" }, now)).toBe(0n);
  });

  test("fails closed on missing, stale and malformed current data instead of using config zero", () => {
    for (const snapshot of [null, false, {}, { ...market.riskFunding, status: "unavailable" },
      { ...market.riskFunding, fundingIndex: null }, { ...market.riskFunding, fundingIndex: "bad" },
      { ...market.riskFunding, updatedAt: now - 60_001 }, { ...market.riskFunding, updatedAt: now + 5_001 }]) {
      const invalid = { fundingIndex: "0", riskFunding: snapshot } as unknown as MarketDisplay;
      expect(currentPositionFundingIndex(invalid, now)).toBeUndefined();
      expect(positionValuation(opening, 20_000_000n, invalid, now)).toEqual({
        fundingPayment: undefined, unrealizedPnl: undefined, netValue: undefined,
      });
    }
    expect(positionFundingPayment(opening, undefined, now)).toBeUndefined();
    expect(positionFundingPayment({ ...opening, fundingIndex: "" }, market, now)).toBeUndefined();
    expect(positionFundingPayment(opening, { fundingIndex: undefined } as unknown as MarketDisplay, now)).toBeUndefined();
    expect(currentPositionFundingIndex({ ...market, riskFunding: { ...market.riskFunding!, fundingIndex: "0" } }, now)).toBe(0n);
  });

  test("counts committed net margin, the actual entry fee and funding exactly once", () => {
    expect(positionValuation(opening, 20_000_000n, market, now)).toEqual({ fundingPayment: 2, unrealizedPnl: -3, netValue: 97 });
    expect(positionValuation({ ...opening, side: "short" }, 20_000_000n, market, now))
      .toEqual({ fundingPayment: -2, unrealizedPnl: 1, netValue: 101 });
    expect(positionValuation({ ...opening, margin: "1003000000", entryFee: "-3000000" }, 20_000_000n, market, now))
      .toEqual({ fundingPayment: 2, unrealizedPnl: -1.7, netValue: 98.3 });
    expect(positionValuation(opening, undefined, market, now)).toEqual({ fundingPayment: 2, unrealizedPnl: undefined, netValue: undefined });
  });

  test("revalues a funding-only refresh without changing the mark or opening", () => {
    const marks = new Map([[market.marketId, { price: 20_000_000n, receivedAt: now }]]);
    const initial = applyLatestOnchainMarks(data(), marks, now);
    const refreshed = applyMarketSummaries(initial, [{ ...summary,
      riskFunding: { ...market.riskFunding!, fundingIndex: "3000000" } }], now);
    expect(refreshed.positions[0]).toMatchObject({ marketPrice: 0.2, fundingPayment: 3, unrealizedPnl: -4, netValue: 96 });
    expect(refreshed.positions[0].privateState).toBe(opening);
    expect(refreshed.orders).toBe(initial.orders);
    const unknown = applyMarketSummaries(refreshed, [{ ...summary, riskFunding: {
      ...market.riskFunding!, status: "unavailable", fundingIndex: null, updatedAt: null,
    } }], now);
    expect(unknown.positions[0].unrealizedPnl).toBeUndefined();
    expect(unknown.positions[0].netValue).toBeUndefined();
    expect(unknown.positions[0].fundingPayment).toBeUndefined();
    expect(applyLatestOnchainMarks(initial, marks, now + 60_001).positions[0].fundingPayment).toBeUndefined();
  });

  test("keeps independent fill accruals and close preview returns in the same units", () => {
    const first = { ...row("0x11"), ...positionValuation(opening, 20_000_000n, market, now) };
    const secondOpening = { ...opening, fundingIndex: "3000000" };
    const second = { ...row("0x22"), privateState: secondOpening, ...positionValuation(secondOpening, 20_000_000n, market, now) };
    const [group] = groupPositionRows([first, second]);
    expect(group.fundingPayment).toBe(1);
    expect(group.unrealizedPnl).toBe(-3);
    expect(group.netValue).toBe(197);
    expect(positionLegs(group).map((leg) => leg.fundingPayment)).toEqual([2, -1]);
    expect(groupPositionRows([first, { ...second, fundingPayment: undefined }])[0].fundingPayment).toBeUndefined();
    const markup = renderToStaticMarkup(createElement(PositionCloseDialog, {
      position: group, onClose: () => undefined, onConfirm: () => undefined,
    }));
    expect(markup).toContain('<span>Funding</span><strong>−$1.00</strong>');
    expect(markup).toContain('<span>Estimated PnL</span><strong class="portfolio-value-negative">−$3.00</strong>');
    expect(markup).toContain('<span>Estimated return</span><strong>$197.00</strong>');
    const independentlyMargined = groupPositionRows([{ ...first, netValue: -4 }, { ...second, netValue: 100 }])[0];
    const separateReturns = renderToStaticMarkup(createElement(PositionCloseDialog, {
      position: independentlyMargined, onClose: () => undefined, onConfirm: () => undefined,
    }));
    expect(separateReturns).toContain('<span>Estimated return</span><strong>$100.00</strong>');
  });
});
