import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppShell } from "@/components/app-shell";
import { PortfolioPage } from "@/components/portfolio-page";
import { emptyLiquidityAccount } from "@/lib/liquidity-account";
import { applyLatestOnchainMarks } from "@/lib/use-trading-data";
import type { WalletSessionController } from "@/lib/use-wallet-session";
import type { MarketDisplay, PositionRow, TradingLiveData } from "@/types/trading";

function portfolio(): TradingLiveData {
  return {
    account: { ...emptyLiquidityAccount, tradedVolume: 0 },
    accountEventCount: 0,
    activity: [],
    markets: [],
    orders: [],
    positions: [],
    ticker: [],
  };
}

function markedPortfolio(entryFee: bigint | undefined, markPrice = 20_000_000n, fundingIndex = "0"): TradingLiveData {
  const trading = portfolio();
  const collateral = 100 - Number(entryFee ?? 0n) / 10_000_000;
  const position: PositionRow = {
    batchId: "batch",
    closePrice: null,
    collateral,
    entryFee: entryFee === undefined ? undefined : Number(entryFee) / 10_000_000,
    entryPrice: 0.2,
    id: "position",
    market: "XLM/USD",
    marketId: "xlm-usd-perp",
    openedAt: 1,
    privateState: {
      entryFee: entryFee?.toString(),
      entryPrice: "20000000",
      fundingIndex: "0",
      margin: (1_000_000_000n - (entryFee ?? 0n)).toString(),
      positionNullifier: "0x01",
      side: "long",
      size: "1000000000",
      sourceIntentCommitment: "0x02",
    },
    side: "long",
    size: 100,
    sourceIntentCommitment: "0x02",
    status: "open",
    time: "00:00",
  };
  trading.account.accountValue = collateral;
  trading.account.lockedMargin = collateral;
  trading.positions = [position];
  trading.markets = [{ marketId: position.marketId, fundingIndex } as MarketDisplay];
  return applyLatestOnchainMarks(trading,
    new Map([[position.marketId, { price: markPrice, receivedAt: 1_000 }]]), 1_000);
}

describe("portfolio balance availability", () => {
  test("does not present disconnected or loading records as a zero balance", () => {
    for (const state of [{ connected: false }, { connected: true, loading: true }]) {
      const markup = renderToStaticMarkup(createElement(PortfolioPage, { ...state, trading: portfolio() }));
      expect(markup).not.toContain("$0.00");
      expect(markup).toContain('class="portfolio-account-value">—</strong>');
    }
  });

  test("keeps verified zero balances and zero PnL visible", () => {
    const markup = renderToStaticMarkup(createElement(PortfolioPage, { connected: true, trading: portfolio() }));
    expect(markup).toContain('class="portfolio-account-value">$0.00</strong>');
    expect(markup).toContain('<span>Available</span><strong>$0.00</strong>');
    expect(markup).toContain('<span>Margin in use</span><strong>$0.00</strong>');
  });

  test("does not replace a missing account balance with zero", () => {
    const trading = portfolio();
    trading.account.accountValue = null;
    trading.account.availableShieldedUsdc = null;
    const markup = renderToStaticMarkup(createElement(PortfolioPage, { connected: true, trading }));
    expect(markup).not.toContain("$0.00");
    expect(markup).toContain('<span>Available</span><strong>—</strong>');
  });

  test("does not treat a failed request's empty data as verified zero", () => {
    const markup = renderToStaticMarkup(createElement(PortfolioPage, {
      connected: true,
      dataError: "Network request failed",
      loading: false,
      onRetry: () => undefined,
      trading: portfolio(),
    }));
    expect(markup).not.toContain("$0.00");
    expect(markup).toContain('class="portfolio-account-value">—</strong>');
    expect(markup).toContain('<span>Available</span><strong>—</strong>');
    expect(markup).toContain('<span>Margin in use</span><strong>—</strong>');
    expect(markup).toContain('<span>Traded volume</span><strong>—</strong>');
    expect(markup).toContain('aria-label="Retry loading portfolio"');
    expect(markup).not.toContain("No open positions");
  });

  test("keeps header collateral explicitly unknown while its supplied data is unavailable", () => {
    const wallet: WalletSessionController = {
      connect: async () => undefined,
      disconnect: () => undefined,
      error: undefined,
      session: { address: "GTESTWALLET", expiresAt: 1_000, ownerCommitment: "0x01", token: "test" },
      status: "connected",
    };
    const shellProps: Parameters<typeof AppShell>[0] = {
      account: null,
      activeView: "portfolio",
      children: createElement("main"),
      wallet,
    };
    const markup = renderToStaticMarkup(createElement(AppShell, shellProps));
    expect(markup).toContain('aria-label="Collateral balance unavailable. Show details"');
    expect(markup).toContain("Balance unavailable.");
    expect(markup).not.toContain("$0.00");
    expect(markup).not.toContain("Collateral breakdown");
  });

  test("does not substitute a known position's missing live P&L with zero", () => {
    const trading = markedPortfolio(10_000_000n);
    trading.positions[0].unrealizedPnl = undefined;
    const markup = renderToStaticMarkup(createElement(PortfolioPage, { connected: true, trading }));
    expect(markup).toContain('class="portfolio-account-value">—</strong>');
    expect(markup).toContain('title="Unrealized P&amp;L is unavailable for one or more open positions."');
    expect(markup).toContain('<span>Margin in use</span><strong>$99.00</strong>');
  });
});

describe("portfolio equity after entry fees", () => {
  test("includes accrued funding once alongside the already-paid entry fee", () => {
    for (const [index, equity, pnl] of [["2000000", "$97.00", "−$3.00"], ["-2000000", "$101.00", "+$1.00"]]) {
      const trading = markedPortfolio(10_000_000n, 20_000_000n, index);
      const markup = renderToStaticMarkup(createElement(PortfolioPage, { connected: true, trading }));
      expect(markup).toContain(`class="portfolio-account-value">${equity}</strong>`);
      expect(markup).toContain(`${pnl}</span>`);
      expect(trading.positions[0].privateState?.fundingIndex).toBe("0");
    }
  });

  test("does not publish equity when the current funding index is unknown", () => {
    const trading = markedPortfolio(10_000_000n, 20_000_000n, "");
    const markup = renderToStaticMarkup(createElement(PortfolioPage, { connected: true, trading }));
    expect(trading.positions[0].unrealizedPnl).toBeUndefined();
    expect(trading.positions[0].netValue).toBeUndefined();
    expect(markup).toContain('class="portfolio-account-value">—</strong>');
    expect(markup).toContain('<span>Margin in use</span><strong>$99.00</strong>');
  });

  test("counts a taker entry fee once at an unchanged mark while keeping net P&L", () => {
    const trading = markedPortfolio(10_000_000n);
    expect(trading.positions[0].unrealizedPnl).toBe(-1);
    const markup = renderToStaticMarkup(createElement(PortfolioPage, { connected: true, trading }));
    expect(markup).toContain('class="portfolio-account-value">$99.00</strong>');
    expect(markup).toContain('class="portfolio-unrealized-negative">−$1.00</span>');
  });

  test("counts a maker rebate once at an unchanged mark while keeping net P&L", () => {
    const trading = markedPortfolio(-3_000_000n);
    expect(trading.positions[0].unrealizedPnl).toBe(0.3);
    const markup = renderToStaticMarkup(createElement(PortfolioPage, { connected: true, trading }));
    expect(markup).toContain('class="portfolio-account-value">$100.30</strong>');
    expect(markup).toContain('class="portfolio-unrealized-positive">+$0.30</span>');
  });

  test("adds price P&L to the collateral remaining after a paid fee", () => {
    const trading = markedPortfolio(10_000_000n, 25_000_000n);
    expect(trading.positions[0].unrealizedPnl).toBe(4);
    const markup = renderToStaticMarkup(createElement(PortfolioPage, { connected: true, trading }));
    expect(markup).toContain('class="portfolio-account-value">$104.00</strong>');
    expect(markup).toContain('class="portfolio-unrealized-positive">+$4.00</span>');
  });

  test("allows legacy fee-free openings and excludes completed positions", () => {
    const trading = markedPortfolio(undefined, 25_000_000n);
    trading.positions.push({ ...trading.positions[0], id: "closed", status: "closed", entryFee: 1, unrealizedPnl: 100 });
    const markup = renderToStaticMarkup(createElement(PortfolioPage, { connected: true, trading }));
    expect(markup).toContain('class="portfolio-account-value">$105.00</strong>');
    expect(markup).toContain('class="portfolio-unrealized-positive">+$5.00</span>');
  });
});
