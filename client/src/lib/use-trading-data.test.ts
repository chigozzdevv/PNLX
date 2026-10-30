import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { MarketHeader } from "@/components/market-header";
import {
  applyLatestOnchainMarks,
  applyMarketSummaries,
  createMarketSummaryRefresh,
  createTradingDataRefresh,
  selectTradeMarkets,
} from "@/lib/use-trading-data";
import type { MarketDisplay, ServerMarketConfig, TradingLiveData } from "@/types/trading";
import { emptyLiquidityAccount } from "@/lib/liquidity-account";

const now = 1_000_000;
const market = { marketId: "xlm-usd-perp", price: 0.21, pair: "XLM/USD", baseAsset: "XLM", quoteAsset: "USD",
  fundingRate: null, openInterest: null, volume: 0, maxLeverage: 10 } as MarketDisplay;
const summary: ServerMarketConfig = {
  marketId: market.marketId, oraclePrice: "21000000", maxLeverage: "10", initialMarginRate: "100000",
  maintenanceMarginRate: "50000", fundingIndex: "0", openInterest: "100000000", fundingRate: "100",
  funding: {
    rate: "100", status: "ready", settlementStatus: "paused", source: "impact-twap", intervalMs: 3_600_000,
    sampleCount: 12, minimumSamples: 10, sampledAt: now, nextFundingAt: null,
  },
  openInterestDetails: { status: "available", updatedAt: now, convention: "half-gross-base" },
};
function data(): TradingLiveData {
  return { markets: [market], positions: [{ id: "position", marketId: market.marketId, status: "open", privateState: {
    side: "long", entryPrice: "20000000", size: "10000000", entryFee: "10000", margin: "1000000",
    fundingIndex: "0", positionNullifier: "0x01", sourceIntentCommitment: "0x02",
  } }], activity: [], orders: [], ticker: [] } as unknown as TradingLiveData;
}

describe("trade market availability", () => {
  test("offers only XLM without removing other markets from account data", () => {
    const markets = [
      { ...market, marketId: "btc-usd-perp", pair: "BTC/USD", baseAsset: "BTC" },
      market,
      { ...market, marketId: "eth-usd-perp", pair: "ETH/USD", baseAsset: "ETH" },
      { ...market, marketId: "sol-usd-perp", pair: "SOL/USD", baseAsset: "SOL" },
      { ...market, marketId: "xrp-usd-perp", pair: "XRP/USD", baseAsset: "XRP" },
    ];

    expect(selectTradeMarkets(markets)).toEqual([market]);
    expect(markets).toHaveLength(5);
    expect(selectTradeMarkets(markets.filter((item) => item.marketId !== market.marketId))).toEqual([]);
  });

  test("shows a static market identity without a market picker", () => {
    const markup = renderToStaticMarkup(createElement(MarketHeader, { selectedMarket: market }));

    expect(markup).toContain("XLM/USD");
    expect(markup).toContain("PNLX volume");
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("aria-expanded");
    expect(markup).not.toContain("market-dropdown");
  });
});

describe("verified market marks", () => {
  test("header price and position PnL use the verified mark", () => {
    const updated = applyLatestOnchainMarks(data(), new Map([[market.marketId, { price: 25_000_000n, receivedAt: now }]]), now);
    expect(updated.markets[0].markPrice).toBe(0.25);
    expect(updated.positions[0].marketPrice).toBe(0.25);
    expect(updated.positions[0].unrealizedPnl).toBeCloseTo(0.049);
    expect(updated.markets[0].price).toBe(0.21);
    const markup = renderToStaticMarkup(createElement(MarketHeader, {
      selectedMarket: updated.markets[0],
    }));
    expect(markup).toContain("Mark price");
    expect(markup).toContain("$0.25000");
  });
  test("stale or unavailable marks clear the pricing mark and live PnL", () => {
    const fresh = applyLatestOnchainMarks(data(), new Map([[market.marketId, { price: 25_000_000n, receivedAt: now }]]), now);
    for (const mark of [{ price: 25_000_000n, receivedAt: now - 10_001 }, { receivedAt: now }]) {
      const cleared = applyLatestOnchainMarks(fresh, new Map([[market.marketId, mark]]), now);
      expect(cleared.markets[0].markPrice).toBeUndefined();
      expect(cleared.positions[0].marketPrice).toBeUndefined();
      expect(cleared.positions[0].unrealizedPnl).toBeUndefined();
    }
  });
  test("snapshot prices are never rendered as verified marks", () => {
    const markup = renderToStaticMarkup(createElement(MarketHeader, { selectedMarket: market }));
    expect(markup).toContain("market-price-block");
    expect(markup).toContain("<span>Mark price</span><strong>—</strong>");
    expect(markup).not.toContain("$0.21000");
  });
});

describe("funding and open-interest summaries", () => {
  test("refreshes public metrics without replacing private account records or verified marks", () => {
    const current = { ...data(), account: { availableShieldedUsdc: 75 } } as TradingLiveData;
    const refreshed = applyLatestOnchainMarks(applyMarketSummaries(current, [summary]),
      new Map([[market.marketId, { price: 30_000_000n, receivedAt: now }]]), now);
    expect(refreshed.account).toBe(current.account);
    expect(refreshed.positions[0].privateState).toBe(current.positions[0].privateState);
    expect(refreshed.orders).toBe(current.orders);
    expect(refreshed.activity).toBe(current.activity);
    expect(refreshed.markets[0].funding?.rate).toBe(0.01);
    expect(refreshed.markets[0].openInterest).toBe(10);
    const markup = renderToStaticMarkup(createElement(MarketHeader, { selectedMarket: refreshed.markets[0] }));
    expect(markup).toContain("Est. funding · 1h");
    expect(markup).toContain("+0.0100%");
    expect(markup).not.toContain(">Paused<");
    expect(markup).toContain("10 XLM");
    expect(markup).toContain("$3.00 at the current verified mark");
    expect(markup).toContain("half the total open size");
    const stale = applyLatestOnchainMarks(refreshed, new Map(), now);
    const staleMarkup = renderToStaticMarkup(createElement(MarketHeader, { selectedMarket: stale.markets[0] }));
    expect(staleMarkup).toContain("10 XLM");
    expect(staleMarkup).not.toContain("$3.00");
  });

  test("distinguishes valid zero aggregates from incomplete or legacy aggregates", () => {
    const available = applyMarketSummaries(data(), [{ ...summary, openInterest: "0", funding: { ...summary.funding!, rate: "0" } }]).markets[0];
    const markup = renderToStaticMarkup(createElement(MarketHeader, { selectedMarket: available }));
    expect(markup).toContain("<span>Open interest</span><strong>0 XLM</strong>");
    expect(markup).toContain("0.0000%");
    for (const selectedMarket of [
      { ...available, openInterestDetails: undefined },
      { ...available, openInterestDetails: { ...available.openInterestDetails!, status: "incomplete" as const, reason: "Incomplete aggregate" } },
    ]) {
      const incomplete = renderToStaticMarkup(createElement(MarketHeader, { selectedMarket }));
      expect(incomplete).toContain('aria-label="Open interest data pending"');
      expect(incomplete).toContain('class="market-metric-dots"');
      expect(incomplete).not.toContain(">Unavailable<");
    }
  });

  test("uses three loading dots for pending funding and keeps status details in tooltips", () => {
    for (const status of ["warming", "stale"] as const) {
      const selectedMarket = applyMarketSummaries(data(), [{ ...summary, funding: { ...summary.funding!, status, rate: null, sampleCount: 3 } }]).markets[0];
      const markup = renderToStaticMarkup(createElement(MarketHeader, { selectedMarket }));
      expect(markup).toContain('aria-label="Est. funding · 1h data pending"');
      expect(markup).toContain('class="market-metric-dots"');
      expect(markup.match(/<span aria-hidden="true"><\/span>/g)).toHaveLength(3);
      expect(markup).not.toContain(status === "warming" ? ">Warming<" : ">Stale<");
      expect(markup).not.toContain(">Paused<");
      expect(markup).toContain("3/10 premium samples");
      expect(markup).not.toContain("+0.0100%");
    }
    const blocked = applyMarketSummaries(data(), [{ ...summary, funding: { ...summary.funding!, settlementStatus: "blocked" } }]).markets[0];
    const markup = renderToStaticMarkup(createElement(MarketHeader, { selectedMarket: blocked }));
    expect(markup).not.toContain(">Blocked<");
    expect(markup).toContain("+0.0100%");
    expect(markup).toContain("Funding settlement is unavailable");
    const missing = renderToStaticMarkup(createElement(MarketHeader, { selectedMarket: market }));
    expect(missing).toContain('aria-label="Est. funding data pending"');
    expect(missing).toContain('aria-label="Open interest data pending"');
    expect(missing).not.toContain(">Unavailable<");
  });
});

describe("public market summary refresh", () => {
  test("prevents overlapping requests and permits the next refresh after completion", async () => {
    let calls = 0;
    let resolve!: (markets: ServerMarketConfig[]) => void;
    const delivered: ServerMarketConfig[][] = [];
    const refresh = createMarketSummaryRefresh(() => {
      calls += 1;
      return new Promise((done) => { resolve = done; });
    }, (markets) => delivered.push(markets));
    const first = refresh.refresh();
    await refresh.refresh();
    expect(calls).toBe(1);
    resolve([summary]);
    await first;
    expect(delivered).toEqual([[summary]]);
    const second = refresh.refresh();
    expect(calls).toBe(2);
    resolve([summary]);
    await second;
    refresh.dispose();
  });

  test("aborts on disposal and ignores late results from the previous session", async () => {
    let signal!: AbortSignal;
    let resolve!: (markets: ServerMarketConfig[]) => void;
    let delivered = false;
    const refresh = createMarketSummaryRefresh((requestSignal) => {
      signal = requestSignal;
      return new Promise((done) => { resolve = done; });
    }, () => { delivered = true; });
    const pending = refresh.refresh();
    refresh.dispose();
    expect(signal.aborted).toBe(true);
    resolve([summary]);
    await pending;
    await refresh.refresh();
    expect(delivered).toBe(false);
  });

  test("retains the current snapshot on a temporary error and retries later", async () => {
    let calls = 0;
    const delivered: ServerMarketConfig[][] = [];
    const refresh = createMarketSummaryRefresh(async () => {
      if (++calls === 1) throw new Error("offline");
      return [summary];
    }, (markets) => delivered.push(markets));
    await refresh.refresh();
    expect(delivered).toEqual([]);
    await refresh.refresh();
    expect(delivered).toEqual([[summary]]);
    refresh.dispose();
  });
});

function accountData(pending = 0): TradingLiveData {
  return { ...data(), account: { ...emptyLiquidityAccount, pendingShieldedUsdc: pending }, orders: [] };
}

function refreshClock() {
  const callbacks = new Map<number, () => void>();
  const delays: number[] = [];
  let id = 0;
  return {
    callbacks, delays,
    schedule(callback: () => void, delay: number) {
      const current = ++id;
      callbacks.set(current, callback);
      delays.push(delay);
      return () => { callbacks.delete(current); };
    },
    fire() {
      const [current, callback] = [...callbacks.entries()][0];
      callbacks.delete(current);
      callback();
    },
  };
}

describe("pending account refresh", () => {
  test("coalesces focus events and schedules only after the full slow request completes", async () => {
    const clock = refreshClock();
    let calls = 0;
    let resolve!: (value: TradingLiveData) => void;
    const snapshot = accountData();
    snapshot.orders.push({ batchId: "ui-pending-1", createdAt: 1, updatedAt: 1, intentCommitment: "0x01",
      isResidual: false, marketId: market.marketId, matchingPayloadCommitment: "0x02", status: "open",
      matching: { state: "proving", message: "Preparing settlement" } });
    const refresh = createTradingDataRefresh(() => {
      calls++;
      return new Promise((done) => { resolve = done; });
    }, () => undefined, () => undefined, { autoRefresh: true, schedule: clock.schedule });
    const first = refresh.refresh();
    expect(refresh.refresh()).toBe(first);
    refresh.visibilityChanged();
    refresh.visibilityChanged();
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(clock.callbacks.size).toBe(0);
    resolve(snapshot);
    await first;
    expect(clock.delays).toEqual([15_000]);
    clock.fire();
    const second = refresh.refresh();
    await Promise.resolve();
    expect(calls).toBe(2);
    expect(clock.callbacks.size).toBe(0);
    resolve(accountData());
    await second;
    expect(clock.callbacks.size).toBe(0);
    refresh.dispose();
  });

  test("pauses while hidden, resumes pending collateral on visibility or focus, and disposes its timer", async () => {
    const clock = refreshClock();
    let visible = true, calls = 0;
    const refresh = createTradingDataRefresh(async () => { calls++; return accountData(36.43); },
      () => undefined, () => undefined,
      { autoRefresh: true, isVisible: () => visible, schedule: clock.schedule });
    await refresh.refresh();
    expect(clock.callbacks.size).toBe(1);
    visible = false;
    refresh.visibilityChanged();
    refresh.visibilityChanged();
    expect(clock.callbacks.size).toBe(0);
    expect(calls).toBe(1);
    visible = true;
    refresh.visibilityChanged();
    await refresh.refresh();
    expect(calls).toBe(2);
    expect(clock.callbacks.size).toBe(1);
    refresh.dispose();
    expect(clock.callbacks.size).toBe(0);
    await refresh.refresh();
    expect(calls).toBe(2);
  });

  test("never applies or schedules an old owner's late result after disposal", async () => {
    const clock = refreshClock();
    let resolve!: (value: TradingLiveData) => void;
    const delivered: string[] = [];
    const old = createTradingDataRefresh(() => new Promise((done) => { resolve = done; }),
      (value) => delivered.push(value.account.address), () => undefined,
      { autoRefresh: true, schedule: clock.schedule });
    const pending = old.refresh();
    await Promise.resolve();
    old.dispose();
    const currentData = accountData(); currentData.account.address = "new-owner";
    const current = createTradingDataRefresh(async () => currentData,
      (value) => delivered.push(value.account.address), () => undefined, { autoRefresh: true, schedule: clock.schedule });
    await current.refresh();
    const oldData = accountData(36.43); oldData.account.address = "old-owner";
    resolve(oldData);
    await pending;
    expect(delivered).toEqual(["new-owner"]);
    expect(clock.callbacks.size).toBe(0);
    current.dispose();
  });

  test("retries a failed pending snapshot and stops after a successful settled snapshot", async () => {
    const clock = refreshClock();
    let calls = 0, errors = 0;
    const refresh = createTradingDataRefresh(async () => {
      if (++calls === 1) throw new Error("offline");
      return accountData();
    }, () => undefined, () => { errors++; }, { autoRefresh: true, schedule: clock.schedule });
    await refresh.refresh();
    expect(errors).toBe(1);
    expect(clock.callbacks.size).toBe(1);
    clock.fire();
    await refresh.refresh();
    expect(calls).toBe(2);
    expect(clock.callbacks.size).toBe(0);
    refresh.dispose();
  });

  test("completed residual leaves stop polling despite the historical partial source status", async () => {
    const clock = refreshClock();
    const snapshot = accountData();
    const source = { batchId: "source", createdAt: 1, updatedAt: 2, intentCommitment: "0x01" as const,
      isResidual: false, marketId: market.marketId, matchingPayloadCommitment: "0x02" as const, status: "partially-filled" as const,
      matching: { state: "settled" as const, message: "Settled" } };
    snapshot.orders.push(source, { ...source, batchId: "residual", intentCommitment: "0x03", isResidual: true,
      sourceIntentCommitment: source.intentCommitment, status: "filled" });
    const refresh = createTradingDataRefresh(async () => snapshot, () => undefined, () => undefined,
      { autoRefresh: true, schedule: clock.schedule });
    await refresh.refresh();
    expect(clock.callbacks.size).toBe(0);
    refresh.dispose();
  });

  test("other hook users keep their one-shot account loading behavior", async () => {
    const clock = refreshClock();
    let calls = 0;
    const refresh = createTradingDataRefresh(async () => { calls++; return accountData(36.43); },
      () => undefined, () => undefined, { schedule: clock.schedule });
    await refresh.refresh();
    refresh.visibilityChanged();
    expect(calls).toBe(1);
    expect(clock.callbacks.size).toBe(0);
    refresh.dispose();
  });
});
