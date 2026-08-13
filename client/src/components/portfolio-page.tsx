import { PositionsTable } from "@/components/positions-table";
import { formatUsd } from "@/lib/format";
import type { PositionRow, ServerOwnerOrderSnapshot, TradingLiveData } from "@/types/trading";

interface PortfolioPageProps {
  actionMessage?: { tone: "error" | "success"; text: string };
  cancellingOrderId?: string;
  closingPositionId?: string;
  loading?: boolean;
  onCancelOrder?: (order: ServerOwnerOrderSnapshot) => Promise<void> | void;
  onClosePosition?: (position: PositionRow) => Promise<void> | void;
  onOpenWithdrawal?: () => void;
  trading: TradingLiveData;
  withdrawingCollateral?: boolean;
}

export function PortfolioPage({
  actionMessage,
  cancellingOrderId,
  closingPositionId,
  loading = false,
  onCancelOrder,
  onClosePosition,
  onOpenWithdrawal,
  trading,
  withdrawingCollateral = false,
}: PortfolioPageProps) {
  const livePnl = trading.positions.reduce((total, position) => total + (position.unrealizedPnl ?? 0), 0);
  const accountValue = trading.account.accountValue ?? 0;
  const availableCollateral = trading.account.availableShieldedUsdc ?? 0;

  return (
    <main className="portfolio-page">
      <section aria-label="Account summary" className="portfolio-summary">
        <div className="portfolio-stat">
          <span>Account Value</span>
          <strong>{formatUsd(accountValue)}</strong>
        </div>
        <div className="portfolio-stat portfolio-stat-with-action">
          <div className="portfolio-stat-value">
            <span>Available</span>
            <strong>{formatUsd(availableCollateral)}</strong>
          </div>
          <button
            className="portfolio-balance-action"
            disabled={!onOpenWithdrawal || withdrawingCollateral || availableCollateral <= 0}
            type="button"
            onClick={onOpenWithdrawal}
          >
            {withdrawingCollateral ? "Withdrawing" : "Withdraw"}
          </button>
        </div>
        <div className="portfolio-stat">
          <span>Margin in Use</span>
          <strong>{formatUsd(trading.account.lockedMargin)}</strong>
        </div>
        <div className="portfolio-stat">
          <span>Unrealized PnL</span>
          <strong className={livePnl >= 0 ? "metric-positive" : "metric-negative"}>
            {livePnl >= 0 ? "+" : ""}
            {formatUsd(livePnl)}
          </strong>
        </div>
        {trading.account.pendingShieldedUsdc > 0 ? (
          <div className="portfolio-stat">
            <span>Pending</span>
            <strong>{formatUsd(trading.account.pendingShieldedUsdc)}</strong>
          </div>
        ) : null}
      </section>

      <PositionsTable
        actionMessage={actionMessage}
        activity={trading.activity}
        cancellingOrderId={cancellingOrderId}
        closingPositionId={closingPositionId}
        loading={loading}
        onCancelOrder={onCancelOrder}
        onClosePosition={onClosePosition}
        orders={trading.orders}
        positions={trading.positions}
      />
    </main>
  );
}
