import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BottomTicker } from "@/components/bottom-ticker";
import { MarketHeader } from "@/components/market-header";
import { OrderTicket } from "@/components/order-ticket";
import type { MarketDisplay, OrderDraft } from "@/types/trading";

const market: MarketDisplay = {
  assetName: "Stellar",
  baseAsset: "XLM",
  change24h: -0.61,
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
  volume24h: 9_999_999,
};

const order: OrderDraft = {
  collateral: 10,
  collateralAsset: "USDC",
  estimatedSize: 625,
  leverage: 10,
  side: "long",
  stopLossPrice: null,
  takeProfitPrice: null,
};

describe("Trade surface", () => {
  test("shows only PNLX market metrics in the header", () => {
    const html = renderToStaticMarkup(
      <MarketHeader markets={[market]} onSelectMarket={() => undefined} selectedMarket={market} />,
    );

    expect(html).toContain("Price");
    expect(html).toContain("Funding Rate");
    expect(html).toContain("Open Interest");
    expect(html).toContain("Volume");
    expect(html).toContain("2.19K XLM");
    expect(html).not.toContain("Oracle Price");
    expect(html).not.toContain("24h Ref");
    expect(html).not.toContain("Max Leverage");
  });

  test("does not duplicate the order estimate summary", () => {
    const html = renderToStaticMarkup(
      <OrderTicket availableCollateral={25} market={market} order={order} />,
    );

    expect(html.match(/Position size/g)).toHaveLength(1);
    expect(html.match(/Exposure/g)).toHaveLength(1);
    expect(html.match(/Est\. liquidation/g)).toHaveLength(1);
    expect(html).toContain("Take Profit / Stop Loss");
    expect(html).not.toContain("Advanced options &amp; order summary");
  });

  test("renders the ticker without a Live or Sync prefix", () => {
    const html = renderToStaticMarkup(
      <BottomTicker ticker={[{ change: -0.61, lastPrice: 0.16, pair: "XLM/USD" }]} />,
    );

    expect(html).toContain("XLM/USD");
    expect(html).not.toContain(">Live<");
    expect(html).not.toContain(">Sync<");
  });
});
