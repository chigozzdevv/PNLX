import { ChevronDown } from "lucide-react";
import Image from "next/image";
import { useState } from "react";
import { formatCompact, formatNumber, formatPct } from "@/lib/format";
import type { MarketDisplay } from "@/types/trading";

interface MarketHeaderProps {
  markets: MarketDisplay[];
  onSelectMarket: (marketId: string) => void;
  selectedMarket: MarketDisplay;
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
  const priceDigits = selectedMarket.price < 10 ? 5 : 2;
  const stats = [
    {
      label: "Funding Rate",
      value: selectedMarket.fundingRate === null ? "—" : formatPct(selectedMarket.fundingRate, 4),
    },
    {
      label: "Open Interest",
      value: selectedMarket.openInterest === null
        ? "—"
        : `${formatCompact(selectedMarket.openInterest)} ${selectedMarket.baseAsset}`,
    },
    {
      label: "Volume",
      value: `${formatCompact(selectedMarket.volume)} ${selectedMarket.baseAsset}`,
    },
  ];

  return (
    <section className="market-header">
      <div
        className="market-identity"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
        }}
      >
        <div className="market-card">
          <AssetLogo asset={selectedMarket.baseAsset} />
          <button
            aria-expanded={open}
            className="market-select-button"
            type="button"
            onClick={() => setOpen((value) => !value)}
          >
            <span>
              <strong>{selectedMarket.pair}</strong>
              <small>Perpetual</small>
            </span>
            <ChevronDown size={17} />
          </button>
        </div>

        {open ? (
          <div className="market-dropdown">
            {markets.map((market) => (
              <button
                className={`market-dropdown-item ${market.marketId === selectedMarket.marketId ? "market-dropdown-item-active" : ""}`}
                key={market.marketId}
                type="button"
                onClick={() => {
                  onSelectMarket(market.marketId);
                  setOpen(false);
                }}
              >
                <AssetLogo asset={market.baseAsset} small />
                <span>
                  <strong>{market.pair}</strong>
                  <small>{market.assetName}</small>
                </span>
                <em>{market.maxLeverage}x</em>
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="market-price-block">
        <span>Price</span>
        <strong>${formatNumber(selectedMarket.price, priceDigits)}</strong>
      </div>

      <div className="market-summary">
        <div className="metric-strip">
          {stats.map((stat) => (
            <div className="metric-item" key={stat.label}>
              <span>{stat.label}</span>
              <strong>{stat.value}</strong>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function AssetLogo({ asset, small = false }: { asset: string; small?: boolean }) {
  const src = ASSET_LOGOS[asset];
  const size = small ? 22 : 30;
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
