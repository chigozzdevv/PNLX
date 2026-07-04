import { AccountStrip } from "@/components/account-strip";
import { PositionsTable } from "@/components/positions-table";
import { formatUsd } from "@/lib/format";
import type { PositionRow, TradingLiveData } from "@/types/trading";

interface PortfolioPageProps {
  actionMessage?: { tone: "error" | "success"; text: string };
  closingPositionId?: string;
  loading?: boolean;
  onClosePosition?: (position: PositionRow) => Promise<void> | void;
  onWithdrawCollateral?: () => Promise<void> | void;
  trading: TradingLiveData;
  withdrawingCollateral?: boolean;
}

export function PortfolioPage({
  actionMessage,
  closingPositionId,
  loading = false,
  onClosePosition,
  onWithdrawCollateral,
  trading,
  withdrawingCollateral = false,
}: PortfolioPageProps) {
  const openPositions = trading.positions.filter((position) => position.status === "open").length;
  const livePnl = trading.positions.reduce((total, position) => total + (position.unrealizedPnl ?? 0), 0);
  const accountValue = trading.account.accountValue ?? 0;
  const availableCollateral = trading.account.availableShieldedUsdc ?? 0;

  return (
    <main className="portfolio-page">
      <AccountStrip
        account={trading.account}
        accountEventCount={trading.accountEventCount}
        ordersCount={trading.orders.length}
        positionsCount={openPositions}
      />

      <section className="portfolio-kpis">
        <div className="portfolio-kpi">
          <span>Account Value</span>
          <strong>{formatUsd(accountValue)}</strong>
        </div>
        <div className="portfolio-kpi portfolio-kpi-with-action">
          <span>Available Collateral</span>
          <strong>{formatUsd(availableCollateral)}</strong>
          <button
            className="secondary-ticket-button portfolio-kpi-action"
            disabled={!onWithdrawCollateral || withdrawingCollateral || availableCollateral <= 0}
            type="button"
            onClick={() => onWithdrawCollateral?.()}
          >
            {withdrawingCollateral ? "Withdrawing" : "Withdraw"}
          </button>
        </div>
        <div className="portfolio-kpi">
          <span>Live PnL</span>
          <strong className={livePnl >= 0 ? "metric-positive" : "metric-negative"}>
            {livePnl >= 0 ? "+" : ""}
            {formatUsd(livePnl)}
          </strong>
        </div>
        <div className="portfolio-kpi">
          <span>Orders</span>
          <strong>{trading.orders.length}</strong>
        </div>
      </section>

      <PositionsTable
        actionMessage={actionMessage}
        activity={trading.activity}
        accountEventCount={trading.accountEventCount}
        closingPositionId={closingPositionId}
        loading={loading}
        onClosePosition={onClosePosition}
        orders={trading.orders}
        positions={trading.positions}
      />
    </main>
  );
}
