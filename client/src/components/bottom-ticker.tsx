import { formatPct } from "@/lib/format";
import type { TickerItem } from "@/types/trading";

interface BottomTickerProps {
  ticker: TickerItem[];
}

export function BottomTicker({ ticker }: BottomTickerProps) {
  return (
    <div className="bottom-ticker">
      <div className="ticker-track">
        {ticker.map((item) => (
          <div className="ticker-item" key={item.pair}>
            <span>{item.pair}</span>
            <strong className={item.change >= 0 ? "text-[var(--accent-green)]" : "text-[var(--accent-red)]"}>
              {formatPct(item.change)}
            </strong>
          </div>
        ))}
      </div>
    </div>
  );
}
