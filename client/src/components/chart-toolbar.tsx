import type { CandleInterval } from "@/lib/use-market-candles";

interface ChartToolbarProps {
  interval: CandleInterval;
  onIntervalChange: (interval: CandleInterval) => void;
}

const intervals: CandleInterval[] = ["1m", "5m", "15m", "1h", "1d"];

export function ChartToolbar({ interval, onIntervalChange }: ChartToolbarProps) {
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
    </div>
  );
}
