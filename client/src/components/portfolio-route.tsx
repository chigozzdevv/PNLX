"use client";

import { useCallback, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { BottomTicker } from "@/components/bottom-ticker";
import { PortfolioPage } from "@/components/portfolio-page";
import { formatUsd, shortAddress } from "@/lib/format";
import { withdrawAvailableCollateral } from "@/lib/collateral-withdraw";
import { closePosition } from "@/lib/position-close";
import { PnlModal } from "@/components/pnl-modal";
import { useMarketTicker } from "@/lib/use-market-ticker";
import { useTradingData } from "@/lib/use-trading-data";
import { useWalletSession } from "@/lib/use-wallet-session";
import type { PositionRow } from "@/types/trading";

export function PortfolioRoute() {
  const wallet = useWalletSession();
  const [refreshKey, setRefreshKey] = useState(0);
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
  const [withdrawingCollateral, setWithdrawingCollateral] = useState(false);
  const [positionActionMessage, setPositionActionMessage] = useState<
    { tone: "error" | "success"; text: string } | undefined
  >();
  const trading = useTradingData(wallet.session, refreshKey);
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

  const handleWithdrawCollateral = useCallback(async () => {
    if (!wallet.session) {
      setPositionActionMessage({ tone: "error", text: "Connect a wallet first" });
      return;
    }

    setWithdrawingCollateral(true);
    setPositionActionMessage(undefined);
    try {
      const result = await withdrawAvailableCollateral(wallet.session);
      setPositionActionMessage({
        tone: "success",
        text: `Withdrew ${formatUsd(result.amount)} to wallet`,
      });
      setRefreshKey((value) => value + 1);
    } catch (error) {
      setPositionActionMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "Withdrawal failed",
      });
    } finally {
      setWithdrawingCollateral(false);
    }
  }, [wallet.session]);

  return (
    <AppShell account={trading.data.account} activeView="portfolio" wallet={wallet}>
      <PortfolioPage
        actionMessage={positionActionMessage}
        closingPositionId={closingPositionId}
        loading={trading.loading}
        onClosePosition={handleClosePosition}
        onWithdrawCollateral={handleWithdrawCollateral}
        trading={trading.data}
        withdrawingCollateral={withdrawingCollateral}
      />
      <BottomTicker ticker={ticker.ticker} live={ticker.live} updatedAt={ticker.updatedAt} />
      <PnlModal
        isOpen={Boolean(pnlModalData)}
        onClose={() => setPnlModalData(null)}
        {...pnlModalData!}
      />
    </AppShell>
  );
}
