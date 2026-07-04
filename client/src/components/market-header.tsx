import { ChevronDown } from "lucide-react";
import Image from "next/image";
import { useState } from "react";
import { formatCompact, formatPct } from "@/lib/format";
import type { MarketDisplay } from "@/types/trading";

interface MarketHeaderProps {
  markets: MarketDisplay[];
  selectedMarket: MarketDisplay;
  onSelectMarket: (marketId: string) => void;
}

const ASSET_LOGOS: Record<string, string> = {
  BTC: "https://s2.coinmarketcap.com/static/img/coins/64x64/1.png",
  ETH: "https://s2.coinmarketcap.com/static/img/coins/64x64/1027.png",
  SOL: "https://s2.coinmarketcap.com/static/img/coins/64x64/5426.png",
  XLM: "https://s2.coinmarketcap.com/static/img/coins/64x64/512.png",
  XRP: "https://s2.coinmarketcap.com/static/img/coins/64x64/52.png",
};

export function MarketHeader({ markets, selectedMarket, onSelectMarket }: MarketHeaderProps) {
  const [open, setOpen] = useState(false);
  const totalOpenInterest = selectedMarket.openInterestLong + selectedMarket.openInterestShort;
  const fundingRate =
    selectedMarket.netRateLong === null || selectedMarket.netRateShort === null
      ? "-- / --"
      : `${formatPct(selectedMarket.netRateLong, 4)} / ${formatPct(selectedMarket.netRateShort, 4)}`;
  const stats = [
    {
      label: "Open Interest",
      value: formatCompact(totalOpenInterest),
    },
    {
      label: "Long / Short",
      value: `${formatCompact(selectedMarket.openInterestLong)} / ${formatCompact(selectedMarket.openInterestShort)}`,
    },
    {
      label: "Funding Rate",
      value: fundingRate,
      mixed: true,
    },
    {
      label: "24h Volume",
      value: formatCompact(selectedMarket.volume24h),
    },
  ];

  return (
    <section className="market-header">
      <div
        className="market-card"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setOpen(false);
          }
        }}
      >
        <AssetLogo asset={selectedMarket.baseAsset} />
        <div className="min-w-0">
          <button
            aria-expanded={open}
            className="market-select-button"
            type="button"
            onClick={() => setOpen((value) => !value)}
          >
            <span className="truncate text-lg font-semibold text-white">{selectedMarket.pair}</span>
            <ChevronDown size={18} className="text-[var(--text-muted)]" />
          </button>
        </div>

        {open ? (
          <div className="market-dropdown">
            {markets.map((market) => (
              <button
                className={`market-dropdown-item ${
                  market.marketId === selectedMarket.marketId ? "market-dropdown-item-active" : ""
                }`}
                key={market.marketId}
                type="button"
                onClick={() => {
                  onSelectMarket(market.marketId);
                  setOpen(false);
                }}
              >
                <AssetLogo asset={market.baseAsset} small />
                <strong>{market.pair}</strong>
                <em>{market.maxLeverage}x</em>
              </button>
            ))}
          </div>
        ) : null}
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

function AssetLogo({ asset, small = false }: { asset: string; small?: boolean }) {
  const src = ASSET_LOGOS[asset];
  const size = small ? 22 : 28;

  return (
    <span className={`asset-logo ${small ? "asset-logo-small" : ""}`}>
      {src ? (
        <Image alt={`${asset} logo`} draggable={false} height={size} src={src} width={size} />
      ) : (
        <strong>{asset.slice(0, 1)}</strong>
      )}
    </span>
  );
}
