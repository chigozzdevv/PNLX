import { ChevronDown } from "lucide-react";
import { formatCompact, formatPct } from "@/lib/format";
import type { MarketDisplay } from "@/types/trading";

interface MarketHeaderProps {
  selectedMarket: MarketDisplay;
  onSelectMarket: (marketId: string) => void;
}

export function MarketHeader({ selectedMarket, onSelectMarket }: MarketHeaderProps) {
  const stats = [
    {
      label: "Open Interest (L)",
      value: `${formatCompact(selectedMarket.openInterestLong)} / ${formatCompact(
        selectedMarket.openInterestLong + selectedMarket.openInterestShort,
      )}`,
    },
    {
      label: "Open Interest (S)",
      value: `${formatCompact(selectedMarket.openInterestShort)} / ${formatCompact(
        selectedMarket.openInterestLong + selectedMarket.openInterestShort,
      )}`,
    },
    {
      label: "Net Rate (L/S)",
      value: `${formatPct(selectedMarket.netRateLong, 4)} / ${formatPct(selectedMarket.netRateShort, 4)}`,
      mixed: true,
    },
    {
      label: "24h Volume",
      value: formatCompact(selectedMarket.volume24h),
    },
  ];

  return (
    <section className="market-header">
      <div className="market-card">
        <div className="asset-badge">{selectedMarket.baseAsset.slice(0, 1)}</div>
        <div className="min-w-0">
          <button
            className="flex min-w-0 items-center gap-2 text-left"
            type="button"
            onClick={() => onSelectMarket(selectedMarket.marketId)}
          >
            <span className="truncate text-lg font-semibold text-white">{selectedMarket.pair}</span>
            <ChevronDown size={18} className="text-[var(--text-muted)]" />
          </button>
        </div>
      </div>

      <div className="market-summary">
        <div className="metric-strip">
          {stats.map((stat) => (
            <div className="metric-item" key={stat.label}>
              <span>{stat.label}</span>
              <strong className={stat.mixed ? "metric-mixed" : ""}>{stat.value}</strong>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
