import { describe, expect, test } from "bun:test";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OrderTicket } from "@/components/order-ticket";

type TicketProps = ComponentProps<typeof OrderTicket>;

const props: TicketProps = {
  market: {
    marketId: "xlm-usd-perp", pair: "XLM/USD", baseAsset: "XLM", quoteAsset: "USD",
    assetName: "Stellar", oraclePrice: "21000000", price: 0.21, change24h: 0,
    fundingRate: null, openInterest: null, volume: 0, fundingIndex: "0",
    maxLeverage: 10, initialMarginRate: 0.1, maintenanceMarginRate: 0.05, status: "live",
  },
  order: {
    side: "long", collateralAsset: "USDC", collateral: 10, estimatedSize: 0,
    leverage: 2, takeProfitPrice: null, stopLossPrice: null,
  },
  mode: "trade",
  onModeChange() {},
  async onConnect() {},
  async onDeposit() {},
  async onSubmit() { throw new Error("Rendering must not submit an order"); },
};

function renderTicket(overrides: Partial<TicketProps> = {}) {
  return renderToStaticMarkup(createElement(OrderTicket, { ...props, ...overrides }));
}

function primaryButton(markup: string) {
  const button = markup.match(/<button\b[^>]*class="primary-trade-button"[^>]*>[^<]*<\/button>/)?.[0];
  expect(button).toBeDefined();
  return button!;
}

describe("order ticket prerequisites", () => {
  test("allows wallet connection before a verified price is available", () => {
    const button = primaryButton(renderTicket({ market: { ...props.market, price: 0 } }));
    expect(button).toContain("Connect Wallet");
    expect(button).not.toContain("disabled=");
    expect(primaryButton(renderTicket({ connecting: true }))).toContain('disabled=""');
    expect(primaryButton(renderTicket({ connecting: true }))).toContain("Connecting…");
  });

  test("offers an actionable funding step when connected collateral is insufficient", () => {
    const button = primaryButton(renderTicket({ connected: true, availableCollateral: 2 }));
    expect(button).toContain("Add funds");
    expect(button).not.toContain("disabled=");
  });

  test("enables funded valid orders and blocks invalid amounts or prices", () => {
    const funded = { connected: true, availableCollateral: 10 };
    const button = primaryButton(renderTicket(funded));
    expect(button).toContain("Buy / Long XLM");
    expect(button).not.toContain("disabled=");
    for (const collateral of [0, 0.000000001]) {
      expect(primaryButton(renderTicket({ ...funded, order: { ...props.order, collateral } }))).toContain('disabled=""');
    }
    expect(primaryButton(renderTicket({ ...funded, market: { ...props.market, price: 0 } }))).toContain('disabled=""');
  });

  test("shows connection failures beside the ticket action", () => {
    const markup = renderTicket({ connectionError: "Wallet request declined" });
    expect(markup).toContain('role="alert"');
    expect(markup).toContain(">Wallet request declined</p>");
  });
});
