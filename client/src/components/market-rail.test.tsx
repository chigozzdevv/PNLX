import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MarketRail } from "@/components/market-rail";
import type { MarketDisplay } from "@/types/trading";

const market: MarketDisplay = {
  assetName: "Stellar",
  baseAsset: "XLM",
  change24h: 0,
  fundingIndex: "0",
  fundingRate: 0,
  initialMarginRate: 0.1,
  maintenanceMarginRate: 0.05,
  marketId: "xlm-usd-perp",
  maxLeverage: 10,
  openInterest: null,
  oraclePrice: "16000000",
  pair: "XLM/USD",
  price: 0.16,
  quoteAsset: "USD",
  status: "live",
  volume: 2_190,
};

describe("MarketRail", () => {
  test("presents configured market price and settled volume without reference-market labels", () => {
    const html = renderToStaticMarkup(
      <MarketRail markets={[market]} onSelectMarket={() => undefined} selectedMarketId={market.marketId} />,
    );

    expect(html).toContain("Markets");
    expect(html).toContain("XLM/USD");
    expect(html).toContain("0.16000");
    expect(html).toContain("2.19K");
    expect(html).toContain("XLM");
    expect(html).toContain('aria-current="true"');
    expect(html).not.toContain("24h");
    expect(html).not.toContain("Hyperliquid");
    expect(html).not.toContain("Order Book");
  });
});
