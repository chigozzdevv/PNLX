"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { BottomTicker } from "@/components/bottom-ticker";
import { ChartToolbar } from "@/components/chart-toolbar";
import { MarketHeader } from "@/components/market-header";
import { OrderTicket } from "@/components/order-ticket";
import { PnlModal } from "@/components/pnl-modal";
import { PositionsTable, type PositionsTableView } from "@/components/positions-table";
import { PriceChart } from "@/components/price-chart";
import { shortAddress } from "@/lib/format";
import { cancelOrder } from "@/lib/order-cancel";
import { closePosition } from "@/lib/position-close";
import { reconcilePrivateMarginNotes } from "@/lib/private-margin-notes";
import { depositPrivateMargin, submitTradeIntent } from "@/lib/trade-submit";
import { useMarketCandles, type CandleInterval } from "@/lib/use-market-candles";
import { useMarketTicker } from "@/lib/use-market-ticker";
import { useTradingData } from "@/lib/use-trading-data";
import { useWalletSession } from "@/lib/use-wallet-session";
import type { OrderTicketSubmitInput } from "@/components/order-ticket";
import type {
  MarketDisplay,
  OrderDraft,
  PositionRow,
  ServerOwnerActivitySnapshot,
  ServerOwnerOrderSnapshot,
  TickerItem,
} from "@/types/trading";

const SELECTED_MARKET_STORAGE_KEY = "pnlx:selected-market-id:v2";
const DEFAULT_MARKET_ID = "xlm-usd-perp";
const OPTIMISTIC_ORDER_TTL_MS = 30_000;

export function TradingPage() {
  const wallet = useWalletSession();
  const [refreshKey, setRefreshKey] = useState(0);
  const [tableView, setTableView] = useState<PositionsTableView>("positions");
  const [closingPositionId, setClosingPositionId] = useState<string | undefined>();
  const [pnlModalData, setPnlModalData] = useState<{
    marketId: string;
    side: "long" | "short";
    size: number;
    entryPrice: number;
    closePrice: number;
    pnl: number;
    collateral: number;
    txHash?: string;
  } | null>(null);
  const [cancellingOrderId, setCancellingOrderId] = useState<string | undefined>();
  const [positionActionMessage, setPositionActionMessage] = useState<
    { tone: "error" | "success"; text: string } | undefined
  >();
  const [optimisticCancelledOrders, setOptimisticCancelledOrders] = useState<Map<string, number>>(
    () => new Map(),
  );
  const [pendingOrders, setPendingOrders] = useState<ServerOwnerOrderSnapshot[]>([]);
  const [optimisticOrderClock, setOptimisticOrderClock] = useState(0);
  const trading = useTradingData(wallet.session, refreshKey);
  const ticker = useMarketTicker(trading.data.ticker);
  const [selectedMarketId, setSelectedMarketId] = useState(readStoredMarketId);
  const [chartInterval, setChartInterval] = useState<CandleInterval>("15m");
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
  const tickerByMarketId = useMemo(
    () => new Map(ticker.ticker.flatMap((item) => (item.marketId ? [[item.marketId, item]] : []))),
    [ticker.ticker],
  );
  const displaySelectedMarket = useMemo(() => {
    if (!liveSelectedMarket) return undefined;
    return enrichMarketWithTicker(liveSelectedMarket, tickerByMarketId.get(liveSelectedMarket.marketId));
  }, [liveSelectedMarket, tickerByMarketId]);
  const orderDraft = displaySelectedMarket ? orderDraftFromMarket(displaySelectedMarket) : undefined;
  const orders = useMemo(() => {
    const liveIds = new Set(trading.data.orders.map((order) => order.intentCommitment));
    const resolvedIds = resolvedOrderIds(trading.data.activity, trading.data.positions);
    const liveOrders = trading.data.orders.map((order) =>
      optimisticCancelledOrders.has(order.intentCommitment)
        ? {
            ...order,
            status: "cancelled" as const,
            updatedAt: Math.max(order.updatedAt, optimisticCancelledOrders.get(order.intentCommitment) ?? 0),
          }
        : order,
    );
    return [
      ...pendingOrders.filter((order) =>
        !liveIds.has(order.intentCommitment) &&
        !resolvedIds.has(order.intentCommitment) &&
        (optimisticOrderClock === 0 || optimisticOrderClock - order.createdAt < OPTIMISTIC_ORDER_TTL_MS)
      ),
      ...liveOrders.filter((order) => isActiveOrderStatus(order.status)),
    ];
  }, [
    optimisticCancelledOrders,
    optimisticOrderClock,
    pendingOrders,
    trading.data.activity,
    trading.data.orders,
    trading.data.positions,
  ]);
  const hasPendingOrders = orders.some((order) => isActiveOrderStatus(order.status));
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
      
      const entryPrice = position.entryPrice ?? 0;
      const closePrice = Number(record.markPrice) / 100_000_000;
      const size = position.size ?? 0;
      const side = position.side ?? "long";
      const collateral = position.collateral ?? 0;
      const delta = side === "long" ? (closePrice - entryPrice) : (entryPrice - closePrice);
      const pnl = size * delta;
      const payout = Math.max(0, collateral + pnl);

      setPnlModalData({
        marketId: position.marketId,
        side,
        size,
        entryPrice,
        closePrice,
        pnl,
        collateral: payout,
        txHash: record.txHash,
      });

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

  const handleCancelOrder = useCallback(async (order: ServerOwnerOrderSnapshot) => {
    if (!wallet.session) {
      setPositionActionMessage({ tone: "error", text: "Connect a wallet first" });
      return;
    }

    setCancellingOrderId(order.intentCommitment);
    setPositionActionMessage(undefined);
    try {
      const cancelled = await cancelOrder({
        intentCommitment: order.intentCommitment,
        token: wallet.session.token,
      });
      setPendingOrders((current) =>
        current.filter((item) => item.intentCommitment !== order.intentCommitment),
      );
      setOptimisticCancelledOrders((current) => {
        const next = new Map(current);
        next.set(cancelled.intentCommitment, Date.now());
        return next;
      });
      reconcilePrivateMarginNotes({
        orders: [{
          intentCommitment: cancelled.intentCommitment,
          status: "cancelled",
        }],
      });
      setPositionActionMessage({
        tone: "success",
        text: `Cancelled ${shortAddress(cancelled.intentCommitment)}`,
      });
      setTableView("orders");
      setRefreshKey((value) => value + 1);
    } catch (error) {
      setPositionActionMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "Order cancel failed",
      });
    } finally {
      setCancellingOrderId(undefined);
    }
  }, [wallet.session]);

  useEffect(() => {
    if (!wallet.session || !hasPendingOrders) return;
    const timer = window.setInterval(() => {
      setRefreshKey((value) => value + 1);
    }, 4_000);
    return () => window.clearInterval(timer);
  }, [hasPendingOrders, wallet.session]);

  useEffect(() => {
    if (pendingOrders.length === 0) return;
    const timer = window.setInterval(() => {
      setOptimisticOrderClock(Date.now());
    }, 4_000);
    return () => window.clearInterval(timer);
  }, [pendingOrders.length]);

  return (
    <AppShell
      account={trading.data.account}
      activeView="trade"
      wallet={wallet}
    >
      <main className="trade-grid">
        <section className="main-column">
          {displaySelectedMarket ? (
            <MarketHeader
              markets={markets}
              selectedMarket={displaySelectedMarket}
              onSelectMarket={handleSelectMarket}
            />
          ) : null}

          <div className="chart-trades-grid">
            <section className="panel chart-panel">
              <ChartToolbar
                interval={chartInterval}
                latest={candles.candles.at(-1)}
                onIntervalChange={setChartInterval}
              />
              {displaySelectedMarket ? (
                <div className="chart-frame">
                  <PriceChart candles={candles.candles} market={displaySelectedMarket} />
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
            cancellingOrderId={cancellingOrderId}
            closingPositionId={closingPositionId}
            loading={trading.loading}
            onCancelOrder={handleCancelOrder}
            onClosePosition={handleClosePosition}
            onViewChange={setTableView}
            orders={orders}
            positions={trading.data.positions}
          />
        </section>

        <aside className="order-column">
          {displaySelectedMarket && orderDraft ? (
            <OrderTicket
              availableCollateral={trading.data.account.availableShieldedUsdc}
              connected={Boolean(wallet.session)}
              session={wallet.session}
              key={displaySelectedMarket.marketId}
              onDeposit={async (input) => {
                if (!wallet.session) throw new Error("Connect a wallet first");
                await depositPrivateMargin({
                  ...input,
                  session: wallet.session,
                });
                setRefreshKey((value) => value + 1);
              }}
              market={displaySelectedMarket}
              onSubmit={async (input: OrderTicketSubmitInput) => {
                if (!wallet.session) throw new Error("Connect a wallet first");
                const result = await submitTradeIntent({
                  ...input,
                  market: displaySelectedMarket,
                  session: wallet.session,
                });
                const submittedAt = Date.now();
                setOptimisticOrderClock(submittedAt);
                setPendingOrders((current) => [
                  {
                    batchId: result.intent.batchId,
                    createdAt: submittedAt,
                    intentCommitment: result.intent.intentCommitment,
                    isResidual: false,
                    matching: {
                      message: "Queued for matching",
                      state: "queued",
                    },
                    marketId: result.intent.marketId,
                    matchingPayloadCommitment: result.intent.matchingPayloadCommitment,
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
      <PnlModal
        isOpen={Boolean(pnlModalData)}
        onClose={() => setPnlModalData(null)}
        {...pnlModalData!}
      />
    </AppShell>
  );
}

function resolvedOrderIds(
  activity: ServerOwnerActivitySnapshot[],
  positions: PositionRow[],
): Set<string> {
  const ids = new Set<string>();
  for (const item of activity) {
    if (item.kind === "order" && !isActiveOrderStatus(item.status)) ids.add(item.id);
  }
  for (const position of positions) {
    if (position.privateState?.sourceIntentCommitment) {
      ids.add(position.privateState.sourceIntentCommitment);
    }
  }
  return ids;
}

function isActiveOrderStatus(status?: string): boolean {
  return status === "open" || status === "partially-filled";
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

function enrichMarketWithTicker(market: MarketDisplay, ticker?: TickerItem): MarketDisplay {
  if (!ticker) return market;
  const protocolOpenInterest = market.openInterestLong + market.openInterestShort;
  const feedOpenInterest = positiveNumber(ticker.openInterest);
  const displayOpenInterest = protocolOpenInterest > 0 ? protocolOpenInterest : feedOpenInterest;
  const feedFunding = finiteNumberOrNull(ticker.fundingRate);

  return {
    ...market,
    change24h: typeof ticker.change === "number" ? ticker.change : market.change24h,
    netRateLong: market.netRateLong ?? feedFunding,
    netRateShort: market.netRateShort ?? (feedFunding === null ? null : -feedFunding),
    openInterestLong: displayOpenInterest > 0 ? displayOpenInterest / 2 : market.openInterestLong,
    openInterestShort: displayOpenInterest > 0 ? displayOpenInterest / 2 : market.openInterestShort,
    price: market.price,
    volume24h: market.volume24h > 0 ? market.volume24h : (ticker.volume24h ?? market.volume24h),
  };
}

function positiveNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function finiteNumberOrNull(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
