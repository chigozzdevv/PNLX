import { AccountStrip } from "@/components/account-strip";
import { PositionsTable } from "@/components/positions-table";
import { formatUsd } from "@/lib/format";
import type { PositionRow, TradingLiveData } from "@/types/trading";

interface PortfolioPageProps {
  actionMessage?: { tone: "error" | "success"; text: string };
  closingPositionId?: string;
  loading?: boolean;
  onClosePosition?: (position: PositionRow) => Promise<void> | void;
  trading: TradingLiveData;
}

export function PortfolioPage({
  actionMessage,
  closingPositionId,
  loading = false,
  onClosePosition,
  trading,
}: PortfolioPageProps) {
  const openPositions = trading.positions.filter((position) => position.status === "open").length;
  const livePnl = trading.positions.reduce((total, position) => total + (position.unrealizedPnl ?? 0), 0);

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
          <strong>{trading.account.accountValue === null ? "Private" : formatUsd(trading.account.accountValue)}</strong>
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
