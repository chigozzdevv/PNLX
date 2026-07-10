import { formatNumber } from "@/lib/format";
import type { ChartCandle, MarketDisplay } from "@/types/trading";

interface PriceChartProps {
  candles: ChartCandle[];
  market: MarketDisplay;
}

const WIDTH = 980;
const HEIGHT = 456;
const PRICE_AXIS_WIDTH = 154;
const PRICE_MARKER_WIDTH = 124;
const PLOT_RIGHT = WIDTH - PRICE_AXIS_WIDTH;
const PRICE_MARKER_X = PLOT_RIGHT + (PRICE_AXIS_WIDTH - PRICE_MARKER_WIDTH) / 2;
const PADDING = { top: 28, right: WIDTH - PLOT_RIGHT, bottom: 34, left: 18 };
const DEFAULT_VISIBLE_CANDLES = 90;

export function PriceChart({ candles, market }: PriceChartProps) {
  const visibleCandles = candles.slice(-DEFAULT_VISIBLE_CANDLES).map(normalizeCandle);
  const hasCandles = visibleCandles.length > 0;
  const highs = hasCandles ? visibleCandles.map((candle) => candle.high) : [market.price * 1.01];
  const lows = hasCandles ? visibleCandles.map((candle) => candle.low) : [market.price * 0.99];
  const rawMin = Math.min(...lows);
  const rawMax = Math.max(...highs);
  const referencePrice = Math.max(Math.abs(market.price), Math.abs(rawMin), Math.abs(rawMax), Number.EPSILON);
  const minimumRange = referencePrice * 0.006;
  const paddedRange = Math.max((rawMax - rawMin) * 1.18, minimumRange);
  const midpoint = (rawMin + rawMax) / 2;
  const min = midpoint - paddedRange / 2;
  const max = midpoint + paddedRange / 2;
  const range = max - min;
  const innerWidth = WIDTH - PADDING.left - PADDING.right;
  const innerHeight = HEIGHT - PADDING.top - PADDING.bottom;
  const candleStep = innerWidth / Math.max(visibleCandles.length - 1, 1);
  const candleWidth = Math.max(3, Math.min(7, candleStep * 0.48));
  const currentY = clamp(
    yFor(market.price, min, range, innerHeight),
    PADDING.top,
    HEIGHT - PADDING.bottom,
  );
  const maxVolume = Math.max(...visibleCandles.map((candle) => candle.volume), 1);
  const footerTime = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    second: "2-digit",
    timeZone: "UTC",
  }).format(new Date());
  const priceTicks = Array.from({ length: 6 }).map((_, index) => {
    const y = PADDING.top + (innerHeight / 5) * index;
    const price = max - (range / 5) * index;

    return { price, y };
  });

  return (
    <div className="chart-canvas">
      <svg
        className="chart-svg h-full w-full"
        preserveAspectRatio="none"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      >
        <defs>
          <linearGradient id="chart-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="rgba(39, 214, 139, 0.14)" />
            <stop offset="100%" stopColor="rgba(39, 214, 139, 0)" />
          </linearGradient>
        </defs>

        <rect height={HEIGHT} width={WIDTH} fill="transparent" />
        {priceTicks.map(({ y }, index) => {
          return (
            <g key={`h-${index}`}>
              <line x1={PADDING.left} x2={PLOT_RIGHT} y1={y} y2={y} className="chart-grid-line" />
            </g>
          );
        })}

        {Array.from({ length: 7 }).map((_, index) => {
          const x = PADDING.left + (innerWidth / 6) * index;
          return (
            <line
              className="chart-grid-line chart-grid-line-soft"
              key={`v-${index}`}
              x1={x}
              x2={x}
              y1={PADDING.top}
              y2={HEIGHT - PADDING.bottom}
            />
          );
        })}

        {visibleCandles.map((candle, index) => {
          const x = PADDING.left + index * candleStep;
          const volumeHeight = Math.max(2, (candle.volume / maxVolume) * 30);
          const isUp = candle.close >= candle.open;

          return (
            <rect
              fill={isUp ? "rgba(39, 214, 139, 0.18)" : "rgba(239, 69, 96, 0.18)"}
              height={volumeHeight}
              key={`v-${candle.time}`}
              rx="1"
              width={Math.max(1.8, candleWidth)}
              x={x - candleWidth / 2}
              y={HEIGHT - PADDING.bottom - volumeHeight}
            />
          );
        })}

        {hasCandles ? (
          <path
            d={`M ${PADDING.left} ${HEIGHT - PADDING.bottom} L ${visibleCandles
              .map((candle, index) =>
                `${PADDING.left + index * candleStep} ${yFor(candle.close, min, range, innerHeight)}`,
              )
              .join(" L ")} L ${PADDING.left + (visibleCandles.length - 1) * candleStep} ${HEIGHT - PADDING.bottom} Z`}
            fill="url(#chart-fill)"
          />
        ) : null}

        <g>
          {visibleCandles.map((candle, index) => {
            const x = PADDING.left + index * candleStep;
            const openY = yFor(candle.open, min, range, innerHeight);
            const closeY = yFor(candle.close, min, range, innerHeight);
            const highY = yFor(candle.high, min, range, innerHeight);
            const lowY = yFor(candle.low, min, range, innerHeight);
            const isUp = candle.close >= candle.open;
            const rawBodyY = Math.min(openY, closeY);
            const rawBodyHeight = Math.abs(closeY - openY);
            const bodyHeight = Math.max(rawBodyHeight, 3.2);
            const bodyMidpointY = (openY + closeY) / 2;
            const bodyY = rawBodyHeight < bodyHeight ? bodyMidpointY - bodyHeight / 2 : rawBodyY;
            const isFlatBody = rawBodyHeight < 1.4;
            const hasVisibleWick = Math.abs(lowY - highY) >= 1;

            return (
              <g key={candle.time}>
                {hasVisibleWick ? (
                  <line
                    x1={x}
                    x2={x}
                    y1={highY}
                    y2={lowY}
                    stroke={isUp ? "var(--accent-green)" : "var(--accent-red)"}
                    strokeLinecap="round"
                    strokeWidth="1.25"
                  />
                ) : null}
                {isFlatBody ? (
                  <line
                    x1={x - candleWidth * 0.68}
                    x2={x + candleWidth * 0.68}
                    y1={bodyMidpointY}
                    y2={bodyMidpointY}
                    stroke={isUp ? "var(--accent-green)" : "var(--accent-red)"}
                    strokeLinecap="square"
                    strokeWidth="2.2"
                  />
                ) : (
                  <rect
                    fill={isUp ? "var(--accent-green)" : "var(--accent-red)"}
                    height={bodyHeight}
                    rx="1.5"
                    width={candleWidth}
                    x={x - candleWidth / 2}
                    y={bodyY}
                  />
                )}
              </g>
            );
          })}
        </g>

        <line
          className="chart-live-price-line"
          x1={PADDING.left}
          x2={PRICE_MARKER_X}
          y1={currentY}
          y2={currentY}
          stroke="var(--accent-red)"
          strokeDasharray="2 5"
          strokeWidth="1.2"
        />

        <text x={PADDING.left + 12} y={PADDING.top + 28} className="chart-title">
          {market.pair} - PNLX
        </text>

        {priceTicks.map(({ price, y }) => (
          <text
            className="chart-axis-value-svg"
            dominantBaseline="middle"
            key={price}
            textAnchor="middle"
            x={PRICE_MARKER_X + PRICE_MARKER_WIDTH / 2}
            y={y}
          >
            {formatNumber(price, price < 10 ? 4 : 1)}
          </text>
        ))}

        <g>
          <rect
            className="chart-price-marker-rect"
            height="30"
            rx="4"
            width={PRICE_MARKER_WIDTH}
            x={PRICE_MARKER_X}
            y={currentY - 15}
          />
          <text
            className="chart-price-marker-text"
            dominantBaseline="middle"
            textAnchor="middle"
            x={PRICE_MARKER_X + PRICE_MARKER_WIDTH / 2}
            y={currentY}
          >
            {formatNumber(market.price, market.price < 10 ? 4 : 1)}
          </text>
        </g>
      </svg>

      <div className="chart-footer">
        <span>{footerTime} UTC</span>
      </div>
    </div>
  );
}

function normalizeCandle(candle: ChartCandle): ChartCandle {
  const open = candle.open;
  const close = candle.close;
  const high = Math.max(candle.high, open, close);
  const low = Math.min(candle.low, open, close);

  return { ...candle, high, low };
}

function yFor(price: number, min: number, range: number, innerHeight: number): number {
  return PADDING.top + ((min + range - price) / range) * innerHeight;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
