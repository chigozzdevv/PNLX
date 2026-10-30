import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarketHeader } from "@/components/market-header";
import { parseMarketDayStats } from "@/lib/market-day-stats";
import type { MarketDayStats, MarketDisplay } from "@/types/trading";

const asOf = 1_800_000_000_000;
const stats: MarketDayStats = {
  marketId: "xlm-usd-perp", source: "hyperliquid", interval: "1m",
  from: asOf - 86_400_000, asOf, fetchedAt: asOf + 2_000,
  open24h: 0.2, lastPrice: 0.21, change24h: 5, high24h: 0.22, low24h: 0.19, stale: false,
};
const market = { marketId: stats.marketId, pair: "XLM/USD", baseAsset: "XLM", quoteAsset: "USD",
  price: 1, markPrice: 0.3, change24h: 0, volume: 20_430, fundingRate: null, openInterest: null } as MarketDisplay;

describe("reference day statistics", () => {
  test("accepts one coherent 24h reference window and detects an old snapshot", () => {
    expect(parseMarketDayStats(stats, stats.marketId, stats.fetchedAt)).toEqual(stats);
    expect(parseMarketDayStats(stats, stats.marketId, asOf + 120_001).stale).toBe(true);
  });

  test("rejects a different market, source, time window, inconsistent change, or invalid range", () => {
    for (const patch of [
      { marketId: "btc-usd-perp" }, { source: "pnlx" }, { from: stats.from + 60_000 },
      { change24h: 10 }, { high24h: 0.205 }, { low24h: 0 }, { lastPrice: Number.NaN },
    ]) {
      expect(() => parseMarketDayStats({ ...stats, ...patch }, stats.marketId, stats.fetchedAt)).toThrow();
    }
  });

  test("renders reference stats independently of the PNLX mark and all-time volume", () => {
    const markup = renderToStaticMarkup(createElement(MarketHeader, { selectedMarket: market, dayStats: stats }));
    expect(markup).toContain("$0.30000");
    expect(markup).toContain("+5.00%");
    expect(markup).toContain("$0.22000");
    expect(markup).toContain("$0.19000");
    expect(markup).toContain("Hyperliquid XLM reference trades");
    expect(markup).toContain("complete 1m candles");
    expect(markup).toContain("All-time PNLX volume");
    expect(markup).toContain("20.43K XLM");
  });

  test("keeps genuine zero change, styles losses, and marks a retained stale snapshot", () => {
    const flat = { ...stats, lastPrice: stats.open24h, change24h: 0 };
    expect(parseMarketDayStats(flat, stats.marketId, stats.fetchedAt).change24h).toBe(0);
    const markup = renderToStaticMarkup(createElement(MarketHeader, {
      selectedMarket: market, dayStats: { ...stats, lastPrice: 0.19, change24h: -5, stale: true },
    }));
    expect(markup).toContain('class="metric-negative"');
    expect(markup).toContain("-5.00%");
    expect(markup).toContain("Stale");
    expect(markup).toContain("Last verified data");
    expect(markup.match(/market-metric-badge/g)).toHaveLength(3);
  });

  test("does not show fabricated zero statistics before the reference feed loads", () => {
    const markup = renderToStaticMarkup(createElement(MarketHeader, { selectedMarket: market }));
    for (const label of ["24h change", "24h high", "24h low"]) {
      expect(markup).toContain(`<span>${label}</span><strong>—</strong>`);
    }
    expect(markup).not.toContain("0.00%");
  });
});
