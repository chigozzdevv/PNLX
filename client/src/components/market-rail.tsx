import { formatCompact, formatNumber } from "@/lib/format";
import type { MarketDisplay } from "@/types/trading";

interface MarketRailProps {
  markets: MarketDisplay[];
  onSelectMarket: (marketId: string) => void;
  selectedMarketId?: string;
}

export function MarketRail({ markets, onSelectMarket, selectedMarketId }: MarketRailProps) {
  return (
    <aside aria-label="Markets" className="market-rail">
      <div className="market-rail-title">
        <strong>Markets</strong>
        <span>{markets.length}</span>
      </div>

      <div aria-hidden="true" className="market-rail-head">
        <span>Market</span>
        <span>Price</span>
        <span>Volume</span>
      </div>

      <div className="market-rail-list">
        {markets.map((market) => {
          const selected = market.marketId === selectedMarketId;
          return (
            <button
              aria-current={selected ? "true" : undefined}
              className={`market-rail-row ${selected ? "market-rail-row-active" : ""}`}
              key={market.marketId}
              type="button"
              onClick={() => onSelectMarket(market.marketId)}
            >
              <span className="market-rail-pair">
                <strong>{market.pair}</strong>
                <small>{market.assetName}</small>
              </span>
              <strong className="market-rail-price">
                {formatMarketPrice(market.price)}
              </strong>
              <span className="market-rail-volume">
                {formatCompact(market.volume)}
                <small>{market.baseAsset}</small>
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

function formatMarketPrice(price: number): string {
  return formatNumber(price, price < 1 ? 5 : price < 10 ? 4 : 2);
}
