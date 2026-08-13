"use client";

import { useCallback, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { BottomTicker } from "@/components/bottom-ticker";
import { PortfolioPage } from "@/components/portfolio-page";
import { WithdrawalModal, type WithdrawableNote } from "@/components/withdrawal-modal";
import { protocolUsdcToDisplay } from "@/lib/asset-units";
import { formatUsd, shortAddress } from "@/lib/format";
import { withdrawPrivateMarginNote } from "@/lib/collateral-withdraw";
import { cancelOrder } from "@/lib/order-cancel";
import { closePosition } from "@/lib/position-close";
import { privateMarginNotes, reconcilePrivateMarginNotes } from "@/lib/private-margin-notes";
import { PnlModal } from "@/components/pnl-modal";
import { useMarketTicker } from "@/lib/use-market-ticker";
import { useTradingData } from "@/lib/use-trading-data";
import { useWalletSession } from "@/lib/use-wallet-session";
import type { PositionRow, ServerOwnerOrderSnapshot } from "@/types/trading";

export function PortfolioRoute() {
  const wallet = useWalletSession();
  const [refreshKey, setRefreshKey] = useState(0);
  const [cancellingOrderId, setCancellingOrderId] = useState<string | undefined>();
  const [closingPositionId, setClosingPositionId] = useState<string | undefined>();
  const [withdrawalOpen, setWithdrawalOpen] = useState(false);
  const [selectedWithdrawalNote, setSelectedWithdrawalNote] = useState<`0x${string}` | undefined>();
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
  const [withdrawingCollateral, setWithdrawingCollateral] = useState(false);
  const [positionActionMessage, setPositionActionMessage] = useState<
    { tone: "error" | "success"; text: string } | undefined
  >();
  const trading = useTradingData(wallet.session, refreshKey);
  const withdrawableNotes: WithdrawableNote[] = wallet.session
    ? privateMarginNotes(wallet.session.ownerCommitment)
      .filter((note) => note.status === "available")
      .sort((left, right) => {
        const leftAmount = BigInt(left.amount);
        const rightAmount = BigInt(right.amount);
        return leftAmount === rightAmount ? left.createdAt - right.createdAt : leftAmount > rightAmount ? -1 : 1;
      })
      .map((note) => ({
        amount: protocolUsdcToDisplay(note.amount),
        commitment: note.commitment,
      }))
    : [];
  const ticker = useMarketTicker(trading.data.ticker);
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

      setPositionActionMessage({ tone: "success", text: `Closed ${shortAddress(record.positionCommitment)}` });
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
      reconcilePrivateMarginNotes({
        orders: [{ intentCommitment: cancelled.intentCommitment, status: "cancelled" }],
      });
      setPositionActionMessage({
        tone: "success",
        text: `Cancelled ${shortAddress(cancelled.intentCommitment)}`,
      });
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

  const handleOpenWithdrawal = () => {
    const first = withdrawableNotes[0];
    if (!first) {
      setPositionActionMessage({ tone: "error", text: "No available private note to withdraw" });
      return;
    }
    setSelectedWithdrawalNote(first.commitment);
    setWithdrawalOpen(true);
  };

  const handleWithdrawCollateral = useCallback(async (noteCommitment: `0x${string}`) => {
    if (!wallet.session) {
      setPositionActionMessage({ tone: "error", text: "Connect a wallet first" });
      return;
    }

    setWithdrawingCollateral(true);
    setPositionActionMessage(undefined);
    try {
      const result = await withdrawPrivateMarginNote(wallet.session, noteCommitment);
      setPositionActionMessage({
        tone: "success",
        text: `Withdrew ${formatUsd(result.amount)} from private note`,
      });
      setWithdrawalOpen(false);
      setSelectedWithdrawalNote(undefined);
      setRefreshKey((value) => value + 1);
    } catch (error) {
      setPositionActionMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "Withdrawal failed",
      });
      setWithdrawalOpen(false);
      setSelectedWithdrawalNote(undefined);
      setRefreshKey((value) => value + 1);
    } finally {
      setWithdrawingCollateral(false);
    }
  }, [wallet.session]);

  return (
    <AppShell account={trading.data.account} activeView="portfolio" wallet={wallet}>
      <PortfolioPage
        actionMessage={positionActionMessage}
        cancellingOrderId={cancellingOrderId}
        closingPositionId={closingPositionId}
        loading={trading.loading}
        onCancelOrder={handleCancelOrder}
        onClosePosition={handleClosePosition}
        onOpenWithdrawal={handleOpenWithdrawal}
        trading={trading.data}
        withdrawingCollateral={withdrawingCollateral}
      />
      <BottomTicker ticker={ticker.ticker} live={ticker.live} updatedAt={ticker.updatedAt} />
      <PnlModal
        isOpen={Boolean(pnlModalData)}
        onClose={() => setPnlModalData(null)}
        {...pnlModalData!}
      />
      <WithdrawalModal
        isOpen={withdrawalOpen}
        notes={withdrawableNotes}
        onClose={() => {
          if (!withdrawingCollateral) setWithdrawalOpen(false);
        }}
        onConfirm={handleWithdrawCollateral}
        onSelect={setSelectedWithdrawalNote}
        selectedCommitment={selectedWithdrawalNote}
        withdrawing={withdrawingCollateral}
      />
    </AppShell>
  );
}
