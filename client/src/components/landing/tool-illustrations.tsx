import { ema, rsi } from "@/lib/chart-indicators";
import styles from "./tool-illustrations.module.css";

export type ToolKind = "charts" | "indicators" | "orders" | "leverage" | "protection" | "positions";

const closes = [
  .1642, .1639, .1645, .1650, .1646, .1653, .1649, .1642, .1638, .1641,
  .1647, .1651, .1648, .1640, .1636, .1644, .1639, .1642, .1647, .1650,
  .1642, .1636, .1647, .1654, .1662, .1655, .1648, .1653, .1664, .1678,
  .1671, .1675,
];
const candles = closes.map((close, i) => {
  const open = closes[i - 1] ?? close;
  return {
    time: new Date(Date.UTC(2026, 9, 24, i * 4)).toISOString(),
    open, close, volume: 0,
    high: Math.max(open, close) + [.0003, .0005, .0002][i % 3],
    low: Math.min(open, close) - [.0004, .0002, .0003][i % 3],
  };
});
const visible = candles.slice(-12);
const averages = ema(candles).slice(-visible.length);
const strengths = rsi(candles).slice(-visible.length);
const low = Math.min(...visible.map(c => c.low));
const high = Math.max(...visible.map(c => c.high));
const x = (i: number) => 10 + i * 20;
const y = (price: number, height: number) => 3 + ((high - price) / (high - low)) * (height - 6);

function CandlePlot({ height }: { height: number }) {
  return visible.map(({ open, close, low, high, time }, i) => (
    <g key={time} className={close >= open ? styles.up : styles.down}>
      <path d={`M${x(i)} ${y(high, height)}V${y(low, height)}`} />
      <rect x={x(i) - 4} y={y(Math.max(open, close), height)} width="8" height={Math.max(1, Math.abs(y(close, height) - y(open, height)))} />
    </g>
  ));
}

const entry = .165;
const mark = visible[visible.length - 1].close;
const size = 1000;
const price = (value: number) => `$${value.toFixed(5)}`;

export function ToolIllustration({ kind }: { kind: ToolKind }) {
  if (kind === "charts") {
    return (
      <span className={styles.art} aria-hidden="true">
        <span className={styles.timeframes}><span>1h</span><b>4h</b><span>1d</span></span>
        <svg className={styles.plot} viewBox="0 0 240 84" fill="none">
          <path d="M0 20H240M0 44H240M0 68H240" className={styles.grid} />
          <CandlePlot height={84} />
        </svg>
      </span>
    );
  }

  if (kind === "indicators") {
    return (
      <span className={styles.art} aria-hidden="true">
        <span className={styles.legend}><span>EMA 20</span><span>RSI 14</span></span>
        <svg className={styles.plot} viewBox="0 0 240 84" fill="none">
          <g opacity=".55"><CandlePlot height={53} /></g>
          <polyline className={styles.ema} points={averages.map(({ value }, i) => `${x(i)},${y(value, 53)}`).join(" ")} />
          <path d="M0 57H240" className={styles.grid} />
          <path d="M0 64.2H240M0 73.8H240" className={styles.grid} strokeDasharray="2 4" />
          <polyline className={styles.rsi} points={strengths.map(({ value }, i) => `${x(i)},${81 - .24 * value}`).join(" ")} />
        </svg>
      </span>
    );
  }

  if (kind === "orders") {
    return (
      <span className={styles.art} aria-hidden="true">
        <span className={styles.sides}><b>Buy / Long</b><span>Sell / Short</span></span>
        <span className={styles.tabs}><span>Market</span><b>Limit</b></span>
        <span className={styles.field}><span>Limit price</span><strong>{entry.toFixed(5)}</strong><small>USD</small></span>
      </span>
    );
  }

  if (kind === "leverage") {
    return (
      <span className={styles.art} aria-hidden="true">
        <span className={styles.multiplier}>5<span>×</span></span>
        <span className={styles.track}><i /></span>
        <span className={styles.ends}><span>1×</span><span>10×</span></span>
      </span>
    );
  }

  if (kind === "protection") {
    return (
      <span className={styles.art} aria-hidden="true">
        <span className={styles.pair}>XLM/USD <b>Long</b></span>
        <span className={styles.levels}>
          <span><b>TP</b><i />{price(.180)}</span>
          <span><b>Entry</b><i />{price(entry)}</span>
          <span><b>SL</b><i />{price(.155)}</span>
        </span>
      </span>
    );
  }

  return (
    <span className={styles.art} aria-hidden="true">
      <span className={styles.pair}>XLM/USD <b>Long</b></span>
      <span className={styles.position}>
        <span><small>Size</small><strong>1,000 XLM</strong></span>
        <span><small>P&amp;L</small><strong className={styles.gain}>+${((mark - entry) * size).toFixed(2)}</strong></span>
        <span><small>Entry</small><strong>{price(entry)}</strong></span>
        <span><small>Mark</small><strong>{price(mark)}</strong></span>
      </span>
    </span>
  );
}
