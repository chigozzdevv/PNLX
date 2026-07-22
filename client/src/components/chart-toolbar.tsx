import type { CandleInterval } from "@/lib/use-market-candles";
import { formatNumber } from "@/lib/format";
import type { ChartCandle } from "@/types/trading";

interface ChartToolbarProps {
  interval: CandleInterval;
  latest?: ChartCandle;
  live: boolean;
  onIntervalChange: (interval: CandleInterval) => void;
}

const intervals: CandleInterval[] = ["1m", "5m", "15m", "1h", "1d"];

export function ChartToolbar({ interval, latest, live, onIntervalChange }: ChartToolbarProps) {
  return (
    <div className="chart-toolbar">
      <span className="chart-label">Price</span>

      <div className="toolbar-group">
        {intervals.map((item) => (
          <button
            className={`time-chip ${item === interval ? "time-chip-active" : ""}`}
            key={item}
            type="button"
            onClick={() => onIntervalChange(item)}
          >
            {item}
          </button>
        ))}
      </div>

      {latest ? (
        <div className="chart-ohlc" aria-label="Current candle values">
          <span>O <strong>{candlePrice(latest.open)}</strong></span>
          <span>H <strong>{candlePrice(latest.high)}</strong></span>
          <span>L <strong>{candlePrice(latest.low)}</strong></span>
          <span>C <strong>{candlePrice(latest.close)}</strong></span>
          <span>Vol <strong>{latest.volume > 0 ? formatNumber(latest.volume, 2) : "—"}</strong></span>
        </div>
      ) : null}

      <span className="chart-feed-status" data-live={live}>
        <i aria-hidden="true" />
        Pyth Index · {live ? "Live" : "Reconnecting"}
      </span>
    </div>
  );
}

function candlePrice(value: number): string {
  return formatNumber(value, value < 10 ? 4 : 2);
}
