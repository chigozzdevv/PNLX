import { formatNumber, formatPct } from "@/lib/format";
import type { TickerItem } from "@/types/trading";

interface BottomTickerProps {
  live?: boolean;
  ticker: TickerItem[];
  updatedAt?: number;
}

export function BottomTicker({ live = false, ticker, updatedAt }: BottomTickerProps) {
  const title = updatedAt ? `Updated ${new Date(updatedAt).toLocaleTimeString()}` : undefined;

  return (
    <div className="bottom-ticker" title={title}>
      <div className={`ticker-status ${live ? "ticker-status-live" : ""}`}>
        <span />
        <strong>{live ? "Live" : "Sync"}</strong>
      </div>
      <div className="ticker-track">
        {ticker.map((item) => (
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
