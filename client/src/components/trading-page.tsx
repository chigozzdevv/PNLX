"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActionToast } from "@/components/action-toast";
import { AppShell } from "@/components/app-shell";
import { ChartToolbar } from "@/components/chart-toolbar";
import { MarketHeader } from "@/components/market-header";
import { LoadingDots } from "@/components/loading-dots";
import { accountEquity } from "@/lib/account-equity";
import { OrderTicket, type OrderTicketSubmitInput } from "@/components/order-ticket";
import { PnlModal, type PnlModalProps } from "@/components/pnl-modal";
import { PositionsTable, type PositionsTableView } from "@/components/positions-table";
import { PriceChart, type PriceChartHandle } from "@/components/price-chart";
import type { ChartIndicatorId } from "@/lib/chart-indicators";
import { protocolUsdcToDisplay } from "@/lib/asset-units";
import { formatUsd } from "@/lib/format";
import type { OwnerOrderGroup } from "@/lib/order-groups";
import {
  findPrivateMarginRepairCandidate,
  repairPrivateMarginNotes,
} from "@/lib/private-margin-notes";
import { positionLegs } from "@/lib/position-groups";
import { summarizePositionCloses } from "@/lib/position-close-summary";
import type { ClosePositionResult } from "@/lib/position-close";
import { useMarketCandles, type CandleInterval } from "@/lib/use-market-candles";
import { useMarketDayStats } from "@/lib/use-market-day-stats";
import { selectTradeMarkets, useTradingData } from "@/lib/use-trading-data";
import { useWalletSession } from "@/lib/use-wallet-session";
import type {
  MarketDisplay,
  OrderDraft,
  PositionRow,
  ServerOwnerActivitySnapshot,
  ServerOwnerOrderSnapshot,
} from "@/types/trading";

const DEFAULT_MARKET_ID = "xlm-usd-perp";
const OPTIMISTIC_ORDER_TTL_MS = 30_000;

export function TradingPage() {
  const wallet = useWalletSession();
  const [refreshKey, setRefreshKey] = useState(0);
  const [tableView, setTableView] = useState<PositionsTableView>("positions");
  const [closingPositionId, setClosingPositionId] = useState<string | undefined>();
  const [pnlModalData, setPnlModalData] = useState<
    Omit<PnlModalProps, "isOpen" | "onClose"> | null
  >(null);
  const [cancellingOrderId, setCancellingOrderId] = useState<string | undefined>();
  const [positionActionMessage, setPositionActionMessage] = useState<
    { tone: "error" | "success"; text: string } | undefined
  >();
  const [optimisticCancelledOrders, setOptimisticCancelledOrders] = useState<Map<string, number>>(
    () => new Map(),
  );
  const [pendingOrders, setPendingOrders] = useState<ServerOwnerOrderSnapshot[]>([]);
  const [optimisticOrderClock, setOptimisticOrderClock] = useState(0);
  const selectedMarketId = DEFAULT_MARKET_ID;
  const trading = useTradingData(wallet.session, refreshKey, selectedMarketId, { autoRefresh: true });
  const recordsMatchWallet = Boolean(wallet.session && trading.data.account.address === wallet.session.address);
  const [chartInterval, setChartInterval] = useState<CandleInterval>("4h");
  const [ticketMode, setTicketMode] = useState<"trade" | "deposit">("trade");
  const [chartIndicators, setChartIndicators] = useState<ChartIndicatorId[]>([]);
  const [chartFullscreen, setChartFullscreen] = useState(false);
  useEffect(() => {
    if (!chartFullscreen) return;
    const previousOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    return () => { document.documentElement.style.overflow = previousOverflow; };
  }, [chartFullscreen]);
  const priceChartRef = useRef<PriceChartHandle>(null);
  const markets = selectTradeMarkets(trading.data.markets);
  const activeMarketId = markets.some((market) => market.marketId === selectedMarketId)
    ? selectedMarketId
    : markets[0]?.marketId;
  const selectedMarket = useMemo(
    () => markets.find((market) => market.marketId === activeMarketId) ?? markets[0],
    [activeMarketId, markets],
  );
  const candles = useMarketCandles(selectedMarket?.marketId, chartInterval);
  const dayStats = useMarketDayStats(selectedMarket?.marketId);
  const displaySelectedMarket = useMemo(() => selectedMarket ? {
    ...selectedMarket, price: selectedMarket.markPrice ?? 0,
  } : undefined, [selectedMarket]);
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
      ...liveOrders,
    ];
  }, [
    optimisticCancelledOrders,
    optimisticOrderClock,
    pendingOrders,
    trading.data.activity,
    trading.data.orders,
    trading.data.positions,
  ]);
  const repairCandidate = useMemo(() => {
    if (!wallet.session) return undefined;
    return findPrivateMarginRepairCandidate({
      hasActiveOrders: orders.some((order) => isActiveOrderStatus(order.status)),
      hasCancelledOrder: trading.data.activity.some(
        (activity) => activity.kind === "order" && activity.status === "cancelled",
      ),
      hasOpenPositions: trading.data.positions.some((position) => position.status === "open"),
      ownerCommitment: wallet.session.ownerCommitment,
    });
  }, [orders, trading.data.activity, trading.data.positions, wallet.session]);
  const hasPendingOrders = orders.some((order) => isActiveOrderStatus(order.status));
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
    const legs = positionLegs(position);
    const records: ClosePositionResult[] = [];
    try {
      const { closePosition } = await import("@/lib/position-close");
      for (const leg of legs) {
        records.push(await closePosition({ market, position: leg, session: wallet.session }));
      }
      const record = records.at(-1);
      if (!record) throw new Error("Position close produced no settlement");
      const side = position.side ?? "long";

      setPnlModalData({
        ...summarizePositionCloses(legs, records),
        marketId: position.marketId,
        side,
        txHash: record.txHash,
      });

      setPositionActionMessage({
        tone: "success",
        text: "Position closed",
      });
      setTableView("positions");
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Position close failed";
      setPositionActionMessage({
        tone: "error",
        text: records.length ? `${records.length} of ${legs.length} fills closed. ${reason}` : reason,
      });
    } finally {
      setRefreshKey((value) => value + 1);
      setClosingPositionId(undefined);
    }
  }, [marketById, wallet.session]);

  const handleCancelOrder = useCallback(async (order: OwnerOrderGroup) => {
    if (!wallet.session) {
      setPositionActionMessage({ tone: "error", text: "Connect a wallet first" });
      return;
    }

    setCancellingOrderId(order.id);
    setPositionActionMessage(undefined);
    try {
      const [{ cancelOrderGroup }, { reconcilePrivateMarginNotes }, { recoverCancelledResiduals }] = await Promise.all([
        import("@/lib/order-cancel"),
        import("@/lib/private-margin-notes"),
        import("@/lib/residual-claim"),
      ]);
      const result = order.activeOrders.length
        ? await cancelOrderGroup({ group: order, token: wallet.session.token })
        : { cancelled: [] as Awaited<ReturnType<typeof cancelOrderGroup>>["cancelled"] };
      const cancelledIds = new Set(result.cancelled.map((item) => item.intentCommitment));
      setPendingOrders((current) =>
        current.filter((item) => !cancelledIds.has(item.intentCommitment)),
      );
      setOptimisticCancelledOrders((current) => {
        const next = new Map(current);
        for (const cancelled of result.cancelled) {
          next.set(cancelled.intentCommitment, Date.now());
        }
        return next;
      });
      reconcilePrivateMarginNotes({
        orders: result.cancelled.map((cancelled) => ({
          intentCommitment: cancelled.intentCommitment,
          noteNullifier: cancelled.noteNullifier,
          sourceIntentCommitment: cancelled.sourceIntentCommitment,
          status: "cancelled",
        })),
      });
      if (result.error) throw result.error;
      const recovered = await recoverCancelledResiduals({
        cancelledIntentCommitments: result.cancelled.map((item) => item.intentCommitment),
        orders: order.orders,
        session: wallet.session,
      });
      setPositionActionMessage({
        tone: "success",
        text: order.activeOrders.length ? (recovered ? "Order cancelled and collateral recovered" : "Order cancelled") : "Collateral recovered",
      });
      setTableView("orders");
    } catch (error) {
      setPositionActionMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "Order cancel failed",
      });
    } finally {
      setCancellingOrderId(undefined);
      setRefreshKey((value) => value + 1);
    }
  }, [wallet.session]);

  const handleRepairCollateral = useCallback(() => {
    if (!repairCandidate) {
      setPositionActionMessage({
        tone: "error",
        text: "No eligible collateral repair found",
      });
      return;
    }

    const sourceAmount = formatUsd(protocolUsdcToDisplay(repairCandidate.sourceAmount), {
      maximumFractionDigits: 2,
      minimumFractionDigits: 2,
    });
    const changeAmount = formatUsd(protocolUsdcToDisplay(repairCandidate.changeAmount), {
      maximumFractionDigits: 2,
      minimumFractionDigits: 2,
    });
    const confirmed = window.confirm(
      `Repair local collateral ledger?\n\n${sourceAmount} source note → Available\n${changeAmount} pending change → Spent\n\nNo transaction will be sent.`,
    );
    if (!confirmed) return;

    if (!repairPrivateMarginNotes(repairCandidate)) {
      setPositionActionMessage({
        tone: "error",
        text: "The local ledger changed before repair; refresh and try again",
      });
      return;
    }

    setPositionActionMessage({
      tone: "success",
      text: "Collateral repaired",
    });
    setRefreshKey((value) => value + 1);
  }, [repairCandidate]);

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

  useEffect(() => {
    const preload = () => {
      void Promise.all([
        import("@/lib/order-cancel"),
        import("@/lib/position-close"),
        import("@/lib/private-margin-notes"),
        import("@/lib/trade-submit"),
      ]);
    };
    if ("requestIdleCallback" in window) {
      const idleId = window.requestIdleCallback(preload, { timeout: 4_000 });
      return () => window.cancelIdleCallback(idleId);
    }
    const timer = globalThis.setTimeout(preload, 1_500);
    return () => globalThis.clearTimeout(timer);
  }, []);

  return (
    <AppShell
      account={trading.loading || trading.error ? null : trading.data.account}
      equity={trading.loading || trading.error ? null : accountEquity(trading.data.account, trading.data.positions).equity}
      activeView="trade"
      onOpenDeposit={displaySelectedMarket && orderDraft ? () => {
        setTicketMode("deposit");
        document.getElementById("trade-order-ticket")?.scrollIntoView({ behavior: "smooth", block: "start" });
      } : undefined}
      onRepairCollateral={handleRepairCollateral}
      showRepairCollateral={Boolean(repairCandidate)}
      wallet={wallet}
    >
      <main className="trade-grid">
        <section className="main-column">
          {displaySelectedMarket ? (
            <MarketHeader dayStats={dayStats} loading={trading.loading} selectedMarket={displaySelectedMarket} />
          ) : trading.loading ? (
            <div aria-hidden="true" className="market-header trade-loading-market-header">
              <span className="trade-loading-block trade-loading-market" />
              <span className="trade-loading-block trade-loading-price" />
              <span className="trade-loading-block trade-loading-metrics" />
            </div>
          ) : null}

          <div className="chart-trades-grid">
            <section className="panel chart-panel">
              <ChartToolbar
                fullscreen={chartFullscreen}
                indicators={chartIndicators}
                interval={chartInterval}
                loadingMore={candles.loadingMore}
                reconnecting={!candles.loading && !candles.live}
                onFullscreen={() => priceChartRef.current?.toggleFullscreen()}
                onIndicatorToggle={(indicator) => {
                  setChartIndicators((current) => current.includes(indicator)
                    ? current.filter((item) => item !== indicator)
                    : [...current, indicator]);
                }}
                onIntervalChange={setChartInterval}
                onReset={() => priceChartRef.current?.reset()}
              />
              {displaySelectedMarket ? (
                <div className="chart-frame">
                  <PriceChart
                    candles={candles.candles}
                    drawingScope={displaySelectedMarket.marketId}
                    indicators={chartIndicators}
                    key={`${displaySelectedMarket.marketId}:${chartInterval}`}
                    market={displaySelectedMarket}
                    onFullscreenChange={setChartFullscreen}
                    onLoadOlder={candles.loadOlder}
                    ref={priceChartRef}
                  />
                  {candles.loading || candles.error ? (
                    <div className="chart-data-status">
                      {candles.loading ? <LoadingDots label="Loading chart" /> : candles.error}
                    </div>
                  ) : null}
                </div>
              ) : trading.loading ? (
                <ChartLoadingPlaceholder />
              ) : (
                <div className="empty-positions min-h-[456px]">
                  <span>{trading.error ?? "No live markets"}</span>
                </div>
              )}
            </section>
          </div>

        </section>

        <aside className="order-column">
          {displaySelectedMarket && orderDraft ? (
            <OrderTicket
              availableCollateral={trading.data.account.availableShieldedUsdc}
              connected={Boolean(wallet.session)}
              connecting={wallet.status === "connecting"}
              connectionError={wallet.status === "error" ? wallet.error : undefined}
              onConnect={wallet.connect}
              mode={ticketMode}
              onModeChange={setTicketMode}
              session={wallet.session}
              key={displaySelectedMarket.marketId}
              onDeposit={async (input) => {
                if (!wallet.session) throw new Error("Connect a wallet first");
                const { depositPrivateMargin } = await import("@/lib/trade-submit");
                await depositPrivateMargin({
                  ...input,
                  session: wallet.session,
                });
                setRefreshKey((value) => value + 1);
              }}
              market={displaySelectedMarket}
              onSubmit={async (input: OrderTicketSubmitInput) => {
                if (!wallet.session) throw new Error("Connect a wallet first");
                const { submitTradeIntent } = await import("@/lib/trade-submit");
                const result = await submitTradeIntent({
                  ...input,
                  market: displaySelectedMarket,
                  session: wallet.session,
                });
                const submittedAt = Date.now();
                setOptimisticOrderClock(submittedAt);
                setPendingOrders((current) => [
                  ...result.intents.map((intent) => ({
                    batchId: intent.batchId,
                    createdAt: submittedAt,
                    intentCommitment: intent.intentCommitment,
                    isResidual: false,
                    matching: {
                      message: "Queued for matching",
                      state: "queued" as const,
                    },
                    marketId: intent.marketId,
                    matchingPayloadCommitment: intent.matchingPayloadCommitment,
                    status: "open" as const,
                    updatedAt: submittedAt,
                  })),
                  ...current.filter((order) =>
                    !result.intents.some((intent) => intent.intentCommitment === order.intentCommitment)
                  ),
                ]);
                setTableView("orders");
                setRefreshKey((value) => value + 1);
                return result;
              }}
              order={orderDraft}
            />
          ) : null}
        </aside>

        <div className="positions-workspace">
          <PositionsTable
            actionMessage={positionActionMessage?.tone === "error" ? positionActionMessage : undefined}
            activity={recordsMatchWallet ? trading.data.activity : []}
            activeView={tableView}
            cancellingOrderId={cancellingOrderId}
            closingPositionId={closingPositionId}
            connected={Boolean(wallet.session)}
            connecting={wallet.status === "connecting"}
            loading={trading.loading || Boolean(wallet.session && !recordsMatchWallet)}
            markets={trading.data.markets}
            unavailable={recordsMatchWallet && Boolean(trading.error)}
            onCancelOrder={handleCancelOrder}
            onClosePosition={handleClosePosition}
            onConnect={wallet.connect}
            onViewChange={setTableView}
            orders={recordsMatchWallet ? orders : []}
            positions={recordsMatchWallet ? trading.data.positions : []}
          />
        </div>
      </main>

      <PnlModal
        isOpen={Boolean(pnlModalData)}
        onClose={() => setPnlModalData(null)}
        {...pnlModalData!}
      />
      <ActionToast
        message={positionActionMessage?.tone === "success" ? positionActionMessage.text : undefined}
        onDismiss={() => {
          setPositionActionMessage((current) => current?.tone === "success" ? undefined : current);
        }}
      />
    </AppShell>
  );
}

function ChartLoadingPlaceholder() {
  return (
    <div aria-label="Loading chart" className="chart-loading-placeholder" role="status">
      <span className="chart-loading-axis" />
      <span className="chart-loading-price-line" />
    </div>
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
