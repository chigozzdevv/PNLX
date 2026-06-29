import { Bell, ChevronDown, CircleDollarSign } from "lucide-react";
import { mockTradingData } from "@/data/mock-trading-data";
import { formatCompact, formatNumber, formatPct } from "@/lib/format";

export function LandingAppPreview() {
  const market = mockTradingData.markets[0];
  const candles = mockTradingData.candlesByMarket[market.marketId].slice(-46);
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
          <strong>MERKL</strong>
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
            <title>Preview of the Merkl trading chart</title>
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
