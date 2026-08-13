import { formatNumber, formatPct } from "@/lib/format";
import type { TickerItem } from "@/types/trading";

interface BottomTickerProps {
  ticker: TickerItem[];
  updatedAt?: number;
}

export function BottomTicker({ ticker, updatedAt }: BottomTickerProps) {
  const visibleTicker = ticker.filter((item) => (
    typeof item.lastPrice === "number" && Number.isFinite(item.lastPrice)
  ));
  const title = updatedAt
    ? `Reference market prices · Updated ${new Date(updatedAt).toLocaleTimeString()}`
    : "Reference market prices";

  return (
    <div aria-label="Reference market prices" className="bottom-ticker" role="region" title={title}>
      <div aria-label="Scroll for more reference markets" className="ticker-track" tabIndex={0}>
        {visibleTicker.map((item) => (
          <div className="ticker-item" key={item.pair}>
            <span>{item.pair}</span>
            {typeof item.lastPrice === "number" ? <em>{formatTickerPrice(item.lastPrice)}</em> : null}
            <strong className={item.change >= 0 ? "text-[var(--accent-green)]" : "text-[var(--accent-red)]"}>
              {formatPct(item.change)}
            </strong>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatTickerPrice(price: number): string {
  return formatNumber(price, price < 1 ? 5 : price < 10 ? 4 : 1);
}
