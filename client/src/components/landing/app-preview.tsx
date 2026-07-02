import { Bell, ChevronDown, CircleDollarSign } from "lucide-react";
import { formatCompact, formatNumber, formatPct } from "@/lib/format";
import type { ChartCandle } from "@/types/trading";

const previewMarket = {
  netRateLong: 0.00017,
  netRateShort: -0.00012,
  openInterestLong: 5_180_000,
  pair: "BTC/USD",
  price: 58_486.33,
  volume24h: 18_420_000,
};

const previewCandles = buildPreviewCandles({
  count: 46,
  end: previewMarket.price,
  seed: 3917,
  start: previewMarket.price * 0.992,
  volatility: 145,
});

export function LandingAppPreview() {
  const market = previewMarket;
  const candles = previewCandles;
  const lows = candles.map((candle) => candle.low);
  const highs = candles.map((candle) => candle.high);
  const min = Math.min(...lows);
  const max = Math.max(...highs);
  const range = max - min || 1;
  const width = 820;
  const height = 330;
  const padX = 34;
  const padY = 28;
  const gap = (width - padX * 2) / Math.max(candles.length - 1, 1);
  const candleWidth = 6.5;

  function yFor(value: number) {
    return padY + (1 - (value - min) / range) * (height - padY * 2);
  }

  return (
    <div className="landing-app-preview">
      <div className="preview-topbar">
        <div className="preview-brand">
          <span>M</span>
          <strong>PNLX</strong>
        </div>
        <div className="preview-nav">
          <span>Trade</span>
          <span>Portfolio</span>
        </div>
        <div className="preview-account">
          <span>0x77ea...2f9c</span>
          <Bell size={15} />
        </div>
      </div>

      <div className="preview-market-row">
        <div className="preview-pair">
          <div className="preview-coin">B</div>
          <strong>{market.pair}</strong>
          <ChevronDown size={16} />
        </div>
        <PreviewMetric label="Price" value={formatNumber(market.price, 1)} positive />
        <PreviewMetric label="Open Interest (L)" value={`${formatCompact(market.openInterestLong)} / 10M`} />
        <PreviewMetric label="Net Rate (L/S)" value={`${formatPct(market.netRateLong, 4)} / ${formatPct(market.netRateShort, 4)}`} />
        <PreviewMetric label="24h Volume" value={formatCompact(market.volume24h)} />
      </div>

      <div className="preview-body">
        <section className="preview-chart-panel">
          <div className="preview-chart-tabs">
            <strong>Price</strong>
            <span>15m</span>
            <span>1h</span>
          </div>
          <svg className="preview-chart" viewBox={`0 0 ${width} ${height}`} role="img">
            <title>Preview of the PNLX trading chart</title>
            {Array.from({ length: 5 }).map((_, index) => {
              const y = padY + index * ((height - padY * 2) / 4);
              return <line className="preview-grid-line" key={`h-${index}`} x1={0} x2={width} y1={y} y2={y} />;
            })}
            {Array.from({ length: 7 }).map((_, index) => {
              const x = padX + index * ((width - padX * 2) / 6);
              return <line className="preview-grid-line preview-grid-line-soft" key={`v-${index}`} x1={x} x2={x} y1={0} y2={height} />;
            })}
            {candles.map((candle, index) => {
              const x = padX + index * gap;
              const openY = yFor(candle.open);
              const closeY = yFor(candle.close);
              const highY = yFor(candle.high);
              const lowY = yFor(candle.low);
              const positive = candle.close >= candle.open;
              const bodyTop = Math.min(openY, closeY);
              const bodyHeight = Math.max(Math.abs(closeY - openY), 3);

              return (
                <g className={positive ? "preview-candle-up" : "preview-candle-down"} key={candle.time}>
                  <line x1={x} x2={x} y1={highY} y2={lowY} />
                  <rect height={bodyHeight} rx={1.4} width={candleWidth} x={x - candleWidth / 2} y={bodyTop} />
                </g>
              );
            })}
          </svg>
        </section>

        <aside className="preview-ticket">
          <div className="preview-side-row">
            <span>Long</span>
            <span>Short</span>
          </div>
          <div className="preview-ticket-field">
            <span>Private Margin</span>
            <strong>100</strong>
            <em>
              <CircleDollarSign size={15} />
              USDC
            </em>
          </div>
          <div className="preview-ticket-field">
            <span>Position Size</span>
            <strong>0.016511</strong>
            <em>BTC</em>
          </div>
          <button type="button">Submit Long</button>
        </aside>
      </div>
    </div>
  );
}

function PreviewMetric({ label, value, positive = false }: { label: string; value: string; positive?: boolean }) {
  return (
    <div className="preview-metric">
      <span>{label}</span>
      <strong className={positive ? "metric-positive" : undefined}>{value}</strong>
    </div>
  );
}

function buildPreviewCandles({
  count,
  end,
  seed,
  start,
  volatility,
}: {
  count: number;
  end: number;
  seed: number;
  start: number;
  volatility: number;
}): ChartCandle[] {
  const candles: ChartCandle[] = [];
  const random = seededRandom(seed);
  let price = start;

  for (let index = 0; index < count; index += 1) {
    const remaining = Math.max(count - index, 1);
    const open = price;
    const drift = (end - price) / remaining;
    const close = index === count - 1
      ? end
      : open + drift + (random() - 0.48) * volatility;
    const body = Math.abs(close - open);
    const wick = volatility * (0.16 + random() * 0.28);

    candles.push({
      close,
      high: Math.max(open, close) + wick + body * 0.16,
      low: Math.max(1, Math.min(open, close) - wick),
      open,
      time: `preview-${index}`,
      volume: 30_000 + random() * 70_000,
    });
    price = close;
  }

  return candles;
}

function seededRandom(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
