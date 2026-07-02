"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { BottomTicker } from "@/components/bottom-ticker";
import { ChartToolbar } from "@/components/chart-toolbar";
import { MarketHeader } from "@/components/market-header";
import { OrderTicket } from "@/components/order-ticket";
import { PositionsTable, type PositionsTableView } from "@/components/positions-table";
import { PriceChart } from "@/components/price-chart";
import { shortAddress } from "@/lib/format";
import { closePosition } from "@/lib/position-close";
import { submitTradeIntent } from "@/lib/trade-submit";
import { useMarketCandles, type CandleInterval } from "@/lib/use-market-candles";
import { useMarketTicker } from "@/lib/use-market-ticker";
import { useTradingData } from "@/lib/use-trading-data";
import { useWalletSession } from "@/lib/use-wallet-session";
import type { OrderTicketSubmitInput } from "@/components/order-ticket";
import type { MarketDisplay, OrderDraft, PositionRow, ServerOwnerOrderSnapshot } from "@/types/trading";

const SELECTED_MARKET_STORAGE_KEY = "pnlx:selected-market-id:v2";
const DEFAULT_MARKET_ID = "xlm-usd-perp";

export function TradingPage() {
  const wallet = useWalletSession();
  const [refreshKey, setRefreshKey] = useState(0);
  const [tableView, setTableView] = useState<PositionsTableView>("positions");
  const [closingPositionId, setClosingPositionId] = useState<string | undefined>();
  const [positionActionMessage, setPositionActionMessage] = useState<
    { tone: "error" | "success"; text: string } | undefined
  >();
  const [pendingOrders, setPendingOrders] = useState<ServerOwnerOrderSnapshot[]>([]);
  const trading = useTradingData(wallet.session, refreshKey);
  const ticker = useMarketTicker(trading.data.ticker);
  const [selectedMarketId, setSelectedMarketId] = useState(readStoredMarketId);
  const [chartInterval, setChartInterval] = useState<CandleInterval>("1m");
  const markets = trading.data.markets;
  const activeMarketId = markets.some((market) => market.marketId === selectedMarketId)
    ? selectedMarketId
    : markets[0]?.marketId;
  const selectedMarket = useMemo(
    () => markets.find((market) => market.marketId === activeMarketId) ?? markets[0],
    [activeMarketId, markets],
  );
  const candles = useMarketCandles(selectedMarket?.marketId, chartInterval);
  const liveSelectedMarket = useMemo(() => {
    if (!selectedMarket) return undefined;
    const latestClose = candles.candles.at(-1)?.close;
    if (!latestClose) return selectedMarket;
    return {
      ...selectedMarket,
      price: latestClose,
    };
  }, [candles.candles, selectedMarket]);
  const orderDraft = liveSelectedMarket ? orderDraftFromMarket(liveSelectedMarket) : undefined;
  const orders = useMemo(() => {
    const liveIds = new Set(trading.data.orders.map((order) => order.intentCommitment));
    return [
      ...pendingOrders.filter((order) => !liveIds.has(order.intentCommitment)),
      ...trading.data.orders,
    ];
  }, [pendingOrders, trading.data.orders]);
  const hasPendingOrders = orders.some((order) => order.status === "open" || order.status === "partially-filled");
  const handleSelectMarket = useCallback((marketId: string) => {
    setSelectedMarketId(marketId);
    writeStoredMarketId(marketId);
  }, []);
  const marketById = useMemo(
    () => new Map(trading.data.markets.map((market) => [market.marketId, market])),
    [trading.data.markets],
  );
  const handleClosePosition = useCallback(async (position: PositionRow) => {
    if (!wallet.session) {
      setPositionActionMessage({ tone: "error", text: "Connect a wallet first" });
      return;
    }
    const market = marketById.get(position.marketId);
    if (!market) {
      setPositionActionMessage({ tone: "error", text: "Market is unavailable" });
      return;
    }

    setClosingPositionId(position.id);
    setPositionActionMessage(undefined);
    try {
      const record = await closePosition({ market, position, session: wallet.session });
      setPositionActionMessage({
        tone: "success",
        text: `Closed ${shortAddress(record.positionCommitment)}`,
      });
      setTableView("positions");
      setRefreshKey((value) => value + 1);
    } catch (error) {
      setPositionActionMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "Position close failed",
      });
    } finally {
      setClosingPositionId(undefined);
    }
  }, [marketById, wallet.session]);

  useEffect(() => {
    if (!wallet.session || !hasPendingOrders) return;
    const timer = window.setInterval(() => {
      setRefreshKey((value) => value + 1);
    }, 4_000);
    return () => window.clearInterval(timer);
  }, [hasPendingOrders, wallet.session]);

  return (
    <AppShell
      account={trading.data.account}
      activeView="trade"
      wallet={wallet}
    >
      <main className="trade-grid">
        <section className="main-column">
          {liveSelectedMarket ? (
            <MarketHeader
              markets={markets}
              selectedMarket={liveSelectedMarket}
              onSelectMarket={handleSelectMarket}
            />
          ) : null}

          <div className="chart-trades-grid">
            <section className="panel chart-panel">
              <ChartToolbar interval={chartInterval} onIntervalChange={setChartInterval} />
              {liveSelectedMarket ? (
                <div className="chart-frame">
                  <PriceChart candles={candles.candles} market={liveSelectedMarket} />
                  {candles.loading || candles.error ? (
                    <div className="chart-data-status">
                      {candles.loading ? "Loading live candles" : candles.error}
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="empty-positions min-h-[456px]">
                  <span>{trading.loading ? "Loading live markets" : trading.error ?? "No live markets"}</span>
                </div>
              )}
            </section>
          </div>

          <PositionsTable
            actionMessage={positionActionMessage}
            activity={trading.data.activity}
            accountEventCount={trading.data.accountEventCount}
            activeView={tableView}
            closingPositionId={closingPositionId}
            loading={trading.loading}
            onClosePosition={handleClosePosition}
            onViewChange={setTableView}
            orders={orders}
            positions={trading.data.positions}
          />
        </section>

        <aside className="order-column">
          {liveSelectedMarket && orderDraft ? (
            <OrderTicket
              connected={Boolean(wallet.session)}
              key={liveSelectedMarket.marketId}
              market={liveSelectedMarket}
              onSubmit={async (input: OrderTicketSubmitInput) => {
                if (!wallet.session) throw new Error("Connect a wallet first");
                const result = await submitTradeIntent({
                  ...input,
                  market: liveSelectedMarket,
                  session: wallet.session,
                });
                const submittedAt = Date.now();
                setPendingOrders((current) => [
                  {
                    batchId: result.intent.batchId,
                    createdAt: submittedAt,
                    intentCommitment: result.intent.intentCommitment,
                    isResidual: false,
                    marketId: result.intent.marketId,
                    shareCommitment: result.intent.shareCommitment,
                    status: "open",
                    updatedAt: submittedAt,
                  },
                  ...current.filter((order) => order.intentCommitment !== result.intent.intentCommitment),
                ]);
                setTableView("orders");
                setRefreshKey((value) => value + 1);
                return result;
              }}
              order={orderDraft}
            />
          ) : null}
        </aside>
      </main>

      <BottomTicker ticker={ticker.ticker} live={ticker.live} updatedAt={ticker.updatedAt} />
    </AppShell>
  );
}

function readStoredMarketId(): string {
  if (typeof window === "undefined") return DEFAULT_MARKET_ID;
  return window.localStorage.getItem(SELECTED_MARKET_STORAGE_KEY) || DEFAULT_MARKET_ID;
}

function writeStoredMarketId(marketId: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(SELECTED_MARKET_STORAGE_KEY, marketId);
}

function orderDraftFromMarket(market: MarketDisplay): OrderDraft {
  const leverage = Math.min(market.maxLeverage, 10);
  const collateral = Math.max(1, Math.ceil(market.price / Math.max(leverage, 1)));

  return {
    collateral,
    collateralAsset: "USDC",
    estimatedSize: market.price > 0 ? (collateral * leverage) / market.price : 0,
    leverage,
    side: "long",
    stopLossPrice: null,
    takeProfitPrice: null,
  };
}
