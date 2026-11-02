"use client";

import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { PortfolioRecords } from "@/components/portfolio-records";
import { accountEquity } from "@/lib/account-equity";
import { formatUsd } from "@/lib/format";
import type { OwnerOrderGroup } from "@/lib/order-groups";
import type { PositionRow, TradingLiveData } from "@/types/trading";

interface PortfolioPageProps {
  actionMessage?: { tone: "error" | "success"; text: string };
  cancellingOrderId?: string;
  closingPositionId?: string;
  connected?: boolean;
  dataError?: string;
  loading?: boolean;
  onCancelOrder?: (order: OwnerOrderGroup) => Promise<void> | void;
  onClosePosition?: (position: PositionRow) => Promise<void> | void;
  onOpenManageFunds?: () => void;
  onRetry?: () => void;
  trading: TradingLiveData;
}

export function PortfolioPage({
  actionMessage,
  cancellingOrderId,
  closingPositionId,
  connected = false,
  dataError,
  loading = false,
  onCancelOrder,
  onClosePosition,
  onOpenManageFunds,
  onRetry,
  trading,
}: PortfolioPageProps) {
  const [balancesHidden, setBalancesHidden] = useState(false);
  const accountReady = connected && !loading && !dataError && trading.account.accountValue !== null;
  const valuation = accountReady ? accountEquity(trading.account, trading.positions) : null;
  const livePnl = valuation?.unrealizedPnl ?? null;
  const accountValue = valuation?.equity ?? null;

  return (
    <main className="account-page portfolio-page">
      <div className="account-page-heading portfolio-heading">
        <h1>Portfolio</h1>
        <button
          className="portfolio-primary-action portfolio-manage-funds"
          disabled={!connected || !onOpenManageFunds}
          type="button"
          onClick={onOpenManageFunds}
        >
          Manage funds
        </button>
      </div>
      <section aria-busy={connected && loading} aria-label="Account overview" className="portfolio-overview">
        <div className="portfolio-account-row">
          <div>
            <span className="portfolio-overview-label">Equity</span>
            <div className="portfolio-account-value-row">
              <strong className="portfolio-account-value">
                {balancesHidden && accountValue !== null ? "••••••" : portfolioUsd(accountValue)}
              </strong>
              <button
                aria-label={balancesHidden ? "Show balances" : "Hide balances"}
                aria-pressed={balancesHidden}
                className="portfolio-visibility-button"
                type="button"
                onClick={() => setBalancesHidden((hidden) => !hidden)}
              >
                {balancesHidden
                  ? <EyeOff aria-hidden="true" size={18} strokeWidth={1.8} />
                  : <Eye aria-hidden="true" size={18} strokeWidth={1.8} />}
              </button>
            </div>
            <p
              className="portfolio-unrealized"
              title={accountReady && livePnl === null
                ? "Unrealized P&L is unavailable for one or more open positions."
                : undefined}
            >
              <span className={!balancesHidden && livePnl !== null && livePnl > 0 ? "portfolio-unrealized-positive"
                : !balancesHidden && livePnl !== null && livePnl < 0 ? "portfolio-unrealized-negative" : ""}>
                {balancesHidden && livePnl !== null ? "••••••" : livePnl === null ? "—" : signedUsd(livePnl)}
              </span>
              <span>unrealized</span>
            </p>
          </div>
        </div>

        <div className="account-stats portfolio-supporting-values">
          <SupportingValue
            hidden={balancesHidden}
            label="Available"
            value={portfolioUsd(accountReady ? trading.account.availableShieldedUsdc : null)}
          />
          <SupportingValue
            hidden={balancesHidden}
            label="Margin in use"
            value={portfolioUsd(accountReady ? trading.account.lockedMargin : null)}
          />
          <SupportingValue
            hidden={balancesHidden}
            label="Traded volume"
            value={portfolioUsd(accountReady ? trading.account.tradedVolume : null)}
          />
        </div>
      </section>

      {dataError ? (
        <div aria-label="Portfolio unavailable" className="page-empty-state" role="alert" title={dataError}>
          {onRetry ? (
            <button aria-label="Retry loading portfolio" className="page-action-secondary" onClick={onRetry} type="button">
              Retry
            </button>
          ) : "Unavailable"}
        </div>
      ) : <PortfolioRecords
        actionMessage={actionMessage}
        activity={trading.activity}
        cancellingOrderId={cancellingOrderId}
        closingPositionId={closingPositionId}
        loading={loading}
        markets={trading.markets}
        onCancelOrder={onCancelOrder}
        onClosePosition={onClosePosition}
        orders={trading.orders}
        positions={trading.positions}
      />}
    </main>
  );
}

function SupportingValue({ hidden, label, value }: { hidden: boolean; label: string; value: string }) {
  return (
    <div className="account-stat portfolio-supporting-value">
      <span>{label}</span>
      <strong>{hidden && value !== "—" ? "••••••" : value}</strong>
    </div>
  );
}

function signedUsd(value: number): string {
  if (Math.abs(value) < Number.EPSILON) return portfolioUsd(0);
  return `${value > 0 ? "+" : "−"}${portfolioUsd(Math.abs(value))}`;
}

function portfolioUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return formatUsd(value, { maximumFractionDigits: 2, minimumFractionDigits: 2 });
}
