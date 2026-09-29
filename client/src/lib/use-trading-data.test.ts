import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { MarketHeader } from "@/components/market-header";
import { applyLatestOnchainMarks } from "@/lib/use-trading-data";
import type { MarketDisplay, TradingLiveData } from "@/types/trading";

const now = 1_000_000;
const market = { marketId: "xlm-usd-perp", price: 0.21, pair: "XLM/USD", baseAsset: "XLM", quoteAsset: "USD",
  fundingRate: null, openInterest: null, volume: 0, maxLeverage: 10 } as MarketDisplay;
function data(): TradingLiveData {
  return { markets: [market], positions: [{ id: "position", marketId: market.marketId, status: "open", privateState: {
    side: "long", entryPrice: "20000000", size: "10000000", entryFee: "10000", margin: "1000000",
    fundingIndex: "0", positionNullifier: "0x01", sourceIntentCommitment: "0x02",
  } }], activity: [], orders: [], ticker: [] } as unknown as TradingLiveData;
}

describe("verified market marks", () => {
  test("the header and position PnL receive the same on-chain mark", () => {
    const updated = applyLatestOnchainMarks(data(), new Map([[market.marketId, { price: 25_000_000n, receivedAt: now }]]), now);
    expect(updated.markets[0].markPrice).toBe(0.25);
    expect(updated.positions[0].marketPrice).toBe(0.25);
    expect(updated.positions[0].unrealizedPnl).toBeCloseTo(0.049);
    expect(updated.markets[0].price).toBe(0.21);
    const markup = renderToStaticMarkup(createElement(MarketHeader, {
      markets: updated.markets, selectedMarket: updated.markets[0], onSelectMarket() {},
    }));
    expect(markup).toContain("Mark price");
    expect(markup).toContain("$0.25000");
  });
  test("stale or unavailable marks clear both the displayed mark and live PnL", () => {
    const fresh = applyLatestOnchainMarks(data(), new Map([[market.marketId, { price: 25_000_000n, receivedAt: now }]]), now);
    for (const mark of [{ price: 25_000_000n, receivedAt: now - 10_001 }, { receivedAt: now }]) {
      const cleared = applyLatestOnchainMarks(fresh, new Map([[market.marketId, mark]]), now);
      expect(cleared.markets[0].markPrice).toBeUndefined();
      expect(cleared.positions[0].marketPrice).toBeUndefined();
      expect(cleared.positions[0].unrealizedPnl).toBeUndefined();
    }
  });
  test("snapshot prices are never rendered as verified marks", () => {
    const markup = renderToStaticMarkup(createElement(MarketHeader, { markets: [market], selectedMarket: market, onSelectMarket() {} }));
    expect(markup).toContain("—");
    expect(markup).not.toContain("$0.21000");
  });
});
