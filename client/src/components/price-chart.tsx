import { motion } from "framer-motion";
import { formatNumber } from "@/lib/format";
import type { ChartCandle, MarketDisplay } from "@/types/trading";

interface PriceChartProps {
  candles: ChartCandle[];
  market: MarketDisplay;
}

const WIDTH = 980;
const HEIGHT = 456;
const PADDING = { top: 28, right: 64, bottom: 34, left: 18 };

export function PriceChart({ candles, market }: PriceChartProps) {
  const highs = candles.map((candle) => candle.high);
  const lows = candles.map((candle) => candle.low);
  const min = Math.min(...lows);
  const max = Math.max(...highs);
  const range = Math.max(max - min, 1);
  const innerWidth = WIDTH - PADDING.left - PADDING.right;
  const innerHeight = HEIGHT - PADDING.top - PADDING.bottom;
  const candleStep = innerWidth / Math.max(candles.length - 1, 1);
  const candleWidth = Math.max(2.2, Math.min(6, candleStep * 0.44));
  const currentY = yFor(market.price, min, range, innerHeight);
  const maxVolume = Math.max(...candles.map((candle) => candle.volume), 1);
  const priceTicks = Array.from({ length: 6 }).map((_, index) => {
    const y = PADDING.top + (innerHeight / 5) * index;
    const price = max - (range / 5) * index;

    return { price, y };
  });

  return (
    <div className="chart-canvas">
      <svg className="h-full w-full" preserveAspectRatio="none" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
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
              <line x1={PADDING.left} x2={WIDTH - PADDING.right} y1={y} y2={y} className="chart-grid-line" />
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

        {candles.map((candle, index) => {
          const x = PADDING.left + index * candleStep;
          const volumeHeight = Math.max(2, (candle.volume / maxVolume) * 30);
          const isUp = candle.close >= candle.open;

          return (
            <rect
              fill={isUp ? "rgba(39, 214, 139, 0.18)" : "rgba(239, 69, 96, 0.18)"}
              height={volumeHeight}
              key={`v-${candle.time}-${index}`}
              rx="1"
              width={Math.max(1.8, candleWidth)}
              x={x - candleWidth / 2}
              y={HEIGHT - PADDING.bottom - volumeHeight}
            />
          );
        })}

        <path
          d={`M ${PADDING.left} ${HEIGHT - PADDING.bottom} L ${candles
            .map((candle, index) => `${PADDING.left + index * candleStep} ${yFor(candle.close, min, range, innerHeight)}`)
            .join(" L ")} L ${PADDING.left + (candles.length - 1) * candleStep} ${HEIGHT - PADDING.bottom} Z`}
          fill="url(#chart-fill)"
        />

        <motion.g initial="hidden" animate="visible">
          {candles.map((candle, index) => {
            const x = PADDING.left + index * candleStep;
            const openY = yFor(candle.open, min, range, innerHeight);
            const closeY = yFor(candle.close, min, range, innerHeight);
            const highY = yFor(candle.high, min, range, innerHeight);
            const lowY = yFor(candle.low, min, range, innerHeight);
            const isUp = candle.close >= candle.open;
            const bodyY = Math.min(openY, closeY);
            const bodyHeight = Math.max(Math.abs(closeY - openY), 2.5);

            return (
              <motion.g
                custom={index}
                key={`${candle.time}-${index}`}
                variants={{
                  hidden: { opacity: 0, y: 8 },
                  visible: (custom: number) => ({
                    opacity: 1,
                    y: 0,
                    transition: { delay: Math.min(custom * 0.002, 0.12), duration: 0.16 },
                  }),
                }}
              >
                <line
                  x1={x}
                  x2={x}
                  y1={highY}
                  y2={lowY}
                  stroke={isUp ? "var(--accent-green)" : "var(--accent-red)"}
                  strokeWidth="0.95"
                />
                <rect
                  fill={isUp ? "var(--accent-green)" : "var(--accent-red)"}
                  height={Math.max(bodyHeight, 1.8)}
                  rx="1.5"
                  width={candleWidth}
                  x={x - candleWidth / 2}
                  y={bodyY}
                />
              </motion.g>
            );
          })}
        </motion.g>

        <line
          x1={PADDING.left}
          x2={WIDTH - PADDING.right}
          y1={currentY}
          y2={currentY}
          stroke="var(--accent-red)"
          strokeDasharray="2 5"
          strokeWidth="1.2"
        />

        <text x={PADDING.left + 12} y={PADDING.top + 28} className="chart-title">
          {market.pair} - Merkl
        </text>
      </svg>

      <div className="chart-price-axis" aria-hidden="true">
        {priceTicks.map(({ price, y }) => (
          <span className="chart-axis-value" key={price} style={{ top: `${(y / HEIGHT) * 100}%` }}>
            {formatNumber(price, price < 10 ? 4 : 1)}
          </span>
        ))}
        <strong className="chart-price-marker" style={{ top: `${(currentY / HEIGHT) * 100}%` }}>
          {formatNumber(market.price, market.price < 10 ? 4 : 1)}
        </strong>
      </div>

      <div className="chart-footer">
        <span>19:18:36 (UTC+1)</span>
      </div>
    </div>
  );
}

function yFor(price: number, min: number, range: number, innerHeight: number): number {
  return PADDING.top + ((min + range - price) / range) * innerHeight;
}
