"use client";

import { Activity, Check, Maximize2, RotateCcw } from "lucide-react";
import type { ChartIndicatorId } from "@/lib/chart-indicators";
import type { CandleInterval } from "@/lib/use-market-candles";

interface ChartToolbarProps {
  indicators: ChartIndicatorId[];
  interval: CandleInterval;
  loadingMore: boolean;
  onFullscreen: () => void;
  onIndicatorToggle: (indicator: ChartIndicatorId) => void;
  onIntervalChange: (interval: CandleInterval) => void;
  onReset: () => void;
}

const intervals: CandleInterval[] = ["1m", "5m", "15m", "1h", "1d"];
const availableIndicators: Array<{ id: ChartIndicatorId; label: string; pane: string }> = [
  { id: "sma", label: "SMA 20", pane: "Price" },
  { id: "ema", label: "EMA 20", pane: "Price" },
  { id: "bollinger", label: "Bollinger Bands", pane: "Price" },
  { id: "vwap", label: "VWAP", pane: "Price" },
  { id: "rsi", label: "RSI 14", pane: "New pane" },
  { id: "macd", label: "MACD 12 26 9", pane: "New pane" },
];

export function ChartToolbar({
  indicators,
  interval,
  loadingMore,
  onFullscreen,
  onIndicatorToggle,
  onIntervalChange,
  onReset,
}: ChartToolbarProps) {
  return (
    <div className="chart-toolbar">
      <div className="toolbar-group" aria-label="Chart interval">
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

      <div className="chart-toolbar-actions">
        <details className="indicator-menu">
          <summary className={indicators.length > 0 ? "chart-tool-active" : ""}>
            <Activity size={15} />
            Indicators
            {indicators.length > 0 ? <em>{indicators.length}</em> : null}
          </summary>
          <div className="indicator-popover">
            <div className="indicator-popover-heading">
              <strong>Indicators</strong>
            </div>
            {availableIndicators.map((indicator) => {
              const active = indicators.includes(indicator.id);
              return (
                <button
                  aria-pressed={active}
                  key={indicator.id}
                  type="button"
                  onClick={() => onIndicatorToggle(indicator.id)}
                >
                  <span className={`indicator-check ${active ? "indicator-check-active" : ""}`}>
                    {active ? <Check size={12} /> : null}
                  </span>
                  <strong>{indicator.label}</strong>
                  <em>{indicator.pane}</em>
                </button>
              );
            })}
          </div>
        </details>

        {loadingMore ? <span className="chart-stream-status">Loading history</span> : null}
        <button aria-label="Reset chart view" className="chart-icon-button" title="Reset chart view" type="button" onClick={onReset}>
          <RotateCcw size={15} />
        </button>
        <button aria-label="Open chart fullscreen" className="chart-icon-button" title="Fullscreen" type="button" onClick={onFullscreen}>
          <Maximize2 size={15} />
        </button>
      </div>
    </div>
  );
}
