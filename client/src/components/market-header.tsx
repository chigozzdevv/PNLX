import Image from "next/image";
import { formatCompact, formatNumber, formatPct, formatUsd } from "@/lib/format";
import type { MarketDayStats, MarketDisplay } from "@/types/trading";

interface MarketHeaderProps {
  dayStats?: MarketDayStats;
  selectedMarket: MarketDisplay;
}

interface HeaderMetric {
  label: string;
  value: string | null;
  description: string;
  badge?: string;
  tone?: "positive" | "negative";
}

function fundingMetric(market: MarketDisplay): HeaderMetric {
  const funding = market.funding;
  if (!funding) return {
    label: "Est. funding",
    value: market.fundingRate !== null && Number.isFinite(market.fundingRate) ? formatPct(market.fundingRate, 4) : null,
    description: "PNLX funding estimate. Settlement status is unavailable.",
  };
  const interval = funding.intervalMs;
  const period = interval > 0 && Number.isFinite(interval)
    ? interval % 3_600_000 === 0 ? `${interval / 3_600_000}h`
      : interval % 60_000 === 0 ? `${interval / 60_000}m` : `${interval / 1_000}s`
    : undefined;
  const settling = funding.settlementStatus === "running";
  const settlement = settling ? "Automatic funding settlement is running."
    : funding.settlementStatus === "paused" ? "Automatic funding settlement is paused; this rate is an estimate."
      : "Funding settlement is unavailable; this rate is an estimate.";
  const sampledAt = funding.sampledAt !== null && funding.sampledAt > 0
    ? ` Last sample: ${new Date(funding.sampledAt).toISOString()}.` : "";
  const progress = `${funding.sampleCount}/${funding.minimumSamples} premium samples`;
  return {
    label: `${settling ? "Funding" : "Est. funding"}${period ? ` · ${period}` : ""}`,
    value: funding.status === "ready" && funding.rate !== null && Number.isFinite(funding.rate)
      ? formatPct(funding.rate, 4) : null,
    description: `${funding.status === "warming" ? `Collecting ${progress}.`
      : funding.status === "stale" ? `PNLX funding samples are out of date (${progress}).`
        : funding.source === "fixed" ? "Configured PNLX funding estimate." : `PNLX funding estimate from ${progress}.`} ${settlement}${sampledAt}`,
  };
}

function openInterestMetric(market: MarketDisplay): HeaderMetric {
  const available = market.openInterestDetails?.status === "available" &&
    market.openInterest !== null && Number.isFinite(market.openInterest) && market.openInterest >= 0;
  if (!available) return {
    label: "Open interest",
    value: null,
    description: market.openInterestDetails?.reason ?? "PNLX has not published a complete open-interest aggregate.",
  };
  const size = market.openInterest!;
  const notional = market.markPrice !== undefined && Number.isFinite(market.markPrice) && market.markPrice > 0
    ? ` ${formatUsd(size * market.markPrice)} at the current verified mark.` : "";
  return {
    label: "Open interest",
    value: `${formatCompact(size)} ${market.baseAsset}`,
    description: `PNLX open interest counts one side of matched positions (half the total open size). ${formatNumber(size, 7)} ${market.baseAsset}.${notional}`,
  };
}

export function MarketHeader({ dayStats, selectedMarket }: MarketHeaderProps) {
  const markPrice = selectedMarket.markPrice;
  const priceDigits = markPrice !== undefined && markPrice < 10 ? 5 : 2;
  const reference = dayStats?.marketId === selectedMarket.marketId ? dayStats : undefined;
  const referenceDescription = reference
    ? `Hyperliquid ${selectedMarket.baseAsset} reference trades. Rolling 24h ending ${new Date(reference.asOf).toISOString()}, using complete 1m candles.${reference.stale ? " Last verified data; refresh is delayed." : ""}`
    : `Hyperliquid ${selectedMarket.baseAsset} reference-price statistics are loading or temporarily unavailable.`;
  const stats: HeaderMetric[] = [
    {
      label: "24h change",
      value: reference ? formatPct(reference.change24h, 2) : "—",
      description: referenceDescription,
      badge: reference?.stale ? "Stale" : undefined,
      tone: reference ? reference.change24h < 0 ? "negative" : reference.change24h > 0 ? "positive" : undefined : undefined,
    },
    {
      label: "24h high",
      value: reference ? `$${formatNumber(reference.high24h, reference.high24h < 10 ? 5 : 2)}` : "—",
      description: referenceDescription,
      badge: reference?.stale ? "Stale" : undefined,
    },
    {
      label: "24h low",
      value: reference ? `$${formatNumber(reference.low24h, reference.low24h < 10 ? 5 : 2)}` : "—",
      description: referenceDescription,
      badge: reference?.stale ? "Stale" : undefined,
    },
    fundingMetric(selectedMarket),
    openInterestMetric(selectedMarket),
    {
      label: "All-time PNLX volume",
      value: `${formatCompact(selectedMarket.volume)} ${selectedMarket.baseAsset}`,
      description: "Total settled PNLX volume across all recorded history, counted once per matched trade.",
    },
  ];

  return (
    <section aria-label={`${selectedMarket.pair} market summary`} className="market-header" tabIndex={0}>
      <div className="market-identity">
        <div className="market-card">
          <span className="asset-logo">
            <Image
              alt="Stellar logo"
              draggable={false}
              height={30}
              src="https://s2.coinmarketcap.com/static/img/coins/64x64/512.png"
              width={30}
            />
          </span>
          <strong className="market-symbol">{selectedMarket.pair}</strong>
        </div>
      </div>

      <div className="market-price-block">
        <span>Mark price</span>
        <strong>{markPrice === undefined ? "—" : `$${formatNumber(markPrice, priceDigits)}`}</strong>
      </div>

      <div className="market-summary">
        <div className="metric-strip">
          {stats.map((stat) => (
            <div className="metric-item" key={stat.label} title={stat.description}>
              <span>{stat.label}</span>
              <strong className={stat.tone ? `metric-${stat.tone}` : undefined}>
                {stat.value ?? <MetricDots label={stat.label} />}
                {stat.badge ? <small className="market-metric-badge">{stat.badge}</small> : null}
              </strong>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function MetricDots({ label }: { label: string }) {
  return (
    <span aria-label={`${label} data pending`} className="market-metric-dots" role="status">
      <span aria-hidden="true" />
      <span aria-hidden="true" />
      <span aria-hidden="true" />
    </span>
  );
}
