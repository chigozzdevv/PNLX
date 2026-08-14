"use client";

import { useCallback, useMemo, useState } from "react";
import { ActionToast } from "@/components/action-toast";
import { AppShell } from "@/components/app-shell";
import { BottomTicker } from "@/components/bottom-ticker";
import { ManageFundsModal, type ManageFundsBalance } from "@/components/manage-funds-modal";
import { PortfolioPage } from "@/components/portfolio-page";
import { PositionCloseDialog } from "@/components/position-close-dialog";
import { protocolUsdcToDisplay } from "@/lib/asset-units";
import { formatUsd } from "@/lib/format";
import { withdrawPrivateMarginNote } from "@/lib/collateral-withdraw";
import { cancelOrder } from "@/lib/order-cancel";
import { closePosition } from "@/lib/position-close";
import { privateMarginNotes, reconcilePrivateMarginNotes } from "@/lib/private-margin-notes";
import { PnlModal, type PnlModalProps } from "@/components/pnl-modal";
import { depositPrivateMargin } from "@/lib/trade-submit";
import { useMarketTicker } from "@/lib/use-market-ticker";
import { useTradingData } from "@/lib/use-trading-data";
import { useWalletSession } from "@/lib/use-wallet-session";
import type { PositionRow, ServerOwnerOrderSnapshot } from "@/types/trading";

export function PortfolioRoute() {
  const wallet = useWalletSession();
  const [refreshKey, setRefreshKey] = useState(0);
  const [cancellingOrderId, setCancellingOrderId] = useState<string | undefined>();
  const [closingPositionId, setClosingPositionId] = useState<string | undefined>();
  const [pendingClosePosition, setPendingClosePosition] = useState<PositionRow | null>(null);
  const [manageFundsOpen, setManageFundsOpen] = useState(false);
  const [selectedWithdrawalNote, setSelectedWithdrawalNote] = useState<`0x${string}` | undefined>();
  const [pnlModalData, setPnlModalData] = useState<
    Omit<PnlModalProps, "isOpen" | "onClose"> | null
  >(null);
  const [depositingCollateral, setDepositingCollateral] = useState(false);
  const [withdrawingCollateral, setWithdrawingCollateral] = useState(false);
  const [positionActionMessage, setPositionActionMessage] = useState<
    { tone: "error" | "success"; text: string } | undefined
  >();
  const trading = useTradingData(wallet.session, refreshKey);
  const withdrawableNotes: ManageFundsBalance[] = wallet.session
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
        createdAt: note.createdAt,
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

      setPnlModalData({
        closePrice,
        entryPrice,
        ...record.settlement,
        marketId: position.marketId,
        side,
        size,
        txHash: record.txHash,
      });

      setPositionActionMessage({ tone: "success", text: "Position closed" });
      setPendingClosePosition(null);
      setRefreshKey((value) => value + 1);
    } catch (error) {
      setPositionActionMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "Position close failed",
      });
      setPendingClosePosition(null);
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
        text: "Order cancelled",
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

  const handleOpenManageFunds = () => {
    if (!wallet.session) {
      setPositionActionMessage({ tone: "error", text: "Connect a wallet first" });
      return;
    }
    setPositionActionMessage(undefined);
    const first = withdrawableNotes[0];
    setSelectedWithdrawalNote(first?.commitment);
    setManageFundsOpen(true);
  };

  const handleDepositCollateral = useCallback(async (amount: number) => {
    if (!wallet.session) {
      setPositionActionMessage({ tone: "error", text: "Connect a wallet first" });
      return;
    }

    setDepositingCollateral(true);
    setPositionActionMessage(undefined);
    try {
      await depositPrivateMargin({
        amount,
        collateralAsset: "USDC",
        session: wallet.session,
      });
      setPositionActionMessage({
        tone: "success",
        text: `${formatUsd(amount, { maximumFractionDigits: 2, minimumFractionDigits: 2 })} deposited`,
      });
      setManageFundsOpen(false);
      setRefreshKey((value) => value + 1);
    } catch (error) {
      setPositionActionMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "Deposit failed",
      });
    } finally {
      setDepositingCollateral(false);
    }
  }, [wallet.session]);

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
        text: `Withdrew ${formatUsd(result.amount, { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`,
      });
      setManageFundsOpen(false);
      setSelectedWithdrawalNote(undefined);
      setRefreshKey((value) => value + 1);
    } catch (error) {
      setPositionActionMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "Withdrawal failed",
      });
      setRefreshKey((value) => value + 1);
    } finally {
      setWithdrawingCollateral(false);
    }
  }, [wallet.session]);

  return (
    <AppShell account={trading.data.account} activeView="portfolio" wallet={wallet}>
      <PortfolioPage
        actionMessage={positionActionMessage?.tone === "error" ? positionActionMessage : undefined}
        cancellingOrderId={cancellingOrderId}
        closingPositionId={closingPositionId}
        connected={Boolean(wallet.session)}
        loading={trading.loading}
        onCancelOrder={handleCancelOrder}
        onClosePosition={setPendingClosePosition}
        onOpenManageFunds={handleOpenManageFunds}
        trading={trading.data}
      />
      <BottomTicker ticker={ticker.ticker} updatedAt={ticker.updatedAt} />
      <PnlModal
        isOpen={Boolean(pnlModalData)}
        onClose={() => setPnlModalData(null)}
        {...pnlModalData!}
      />
      <ManageFundsModal
        address={wallet.session?.address ?? trading.data.account.address}
        available={trading.data.account.availableShieldedUsdc ?? 0}
        depositing={depositingCollateral}
        isOpen={manageFundsOpen}
        message={positionActionMessage?.tone === "error" ? positionActionMessage : undefined}
        notes={withdrawableNotes}
        onClose={() => {
          if (!depositingCollateral && !withdrawingCollateral) setManageFundsOpen(false);
        }}
        onDeposit={handleDepositCollateral}
        onSelect={setSelectedWithdrawalNote}
        onWithdraw={handleWithdrawCollateral}
        selectedCommitment={selectedWithdrawalNote}
        withdrawing={withdrawingCollateral}
      />
      <PositionCloseDialog
        closing={Boolean(pendingClosePosition && closingPositionId === pendingClosePosition.id)}
        onClose={() => {
          if (!closingPositionId) setPendingClosePosition(null);
        }}
        onConfirm={handleClosePosition}
        position={pendingClosePosition}
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
