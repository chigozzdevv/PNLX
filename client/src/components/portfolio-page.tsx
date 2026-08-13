"use client";

import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { PortfolioRecords } from "@/components/portfolio-records";
import { formatUsd } from "@/lib/format";
import type { PositionRow, ServerOwnerOrderSnapshot, TradingLiveData } from "@/types/trading";

interface PortfolioPageProps {
  actionMessage?: { tone: "error" | "success"; text: string };
  cancellingOrderId?: string;
  closingPositionId?: string;
  connected?: boolean;
  loading?: boolean;
  onCancelOrder?: (order: ServerOwnerOrderSnapshot) => Promise<void> | void;
  onClosePosition?: (position: PositionRow) => Promise<void> | void;
  onOpenManageFunds?: () => void;
  trading: TradingLiveData;
}

export function PortfolioPage({
  actionMessage,
  cancellingOrderId,
  closingPositionId,
  connected = false,
  loading = false,
  onCancelOrder,
  onClosePosition,
  onOpenManageFunds,
  trading,
}: PortfolioPageProps) {
  const [balancesHidden, setBalancesHidden] = useState(false);
  const livePnl = trading.positions
    .filter((position) => position.status === "open")
    .reduce((total, position) => total + (position.unrealizedPnl ?? 0), 0);
  const collateral = trading.account.accountValue ?? 0;
  const accountValue = collateral + livePnl;

  return (
    <main className="portfolio-page">
      <section aria-label="Account overview" className="portfolio-overview">
        <div className="portfolio-account-row">
          <div>
            <span className="portfolio-overview-label">Account value</span>
            <div className="portfolio-account-value-row">
              <strong className="portfolio-account-value">
                {balancesHidden ? "••••••" : portfolioUsd(accountValue)}
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
            <p className="portfolio-unrealized">
              <span className={livePnl > 0 ? "portfolio-unrealized-positive" : livePnl < 0 ? "portfolio-unrealized-negative" : ""}>
                {balancesHidden ? "••••••" : signedUsd(livePnl)}
              </span>
              <span>unrealized</span>
            </p>
          </div>
          <button
            className="portfolio-primary-action portfolio-manage-funds"
            disabled={!connected || !onOpenManageFunds}
            type="button"
            onClick={onOpenManageFunds}
          >
            Manage funds
          </button>
        </div>

        <div className="portfolio-supporting-values">
          <SupportingValue
            hidden={balancesHidden}
            label="Available"
            value={portfolioUsd(trading.account.availableShieldedUsdc ?? 0)}
          />
          <SupportingValue
            hidden={balancesHidden}
            label="Margin in use"
            value={portfolioUsd(trading.account.lockedMargin)}
          />
          {trading.account.tradedVolume !== null ? (
            <SupportingValue
              hidden={balancesHidden}
              label="Traded volume"
              value={portfolioUsd(trading.account.tradedVolume)}
            />
          ) : null}
        </div>
      </section>

      <PortfolioRecords
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

function SupportingValue({ hidden, label, value }: { hidden: boolean; label: string; value: string }) {
  return (
    <div className="portfolio-supporting-value">
      <span>{label}</span>
      <strong>{hidden && value !== "—" ? "••••••" : value}</strong>
    </div>
  );
}

function signedUsd(value: number): string {
  if (Math.abs(value) < Number.EPSILON) return portfolioUsd(0);
  return `${value > 0 ? "+" : "−"}${portfolioUsd(Math.abs(value))}`;
}

function portfolioUsd(value: number): string {
  return formatUsd(value, { maximumFractionDigits: 2, minimumFractionDigits: 2 });
}
