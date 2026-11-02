import Image from "next/image";
import { LoadingDots } from "@/components/loading-dots";
import { formatCompact, formatNumber, formatPct } from "@/lib/format";
import type { MarketDayStats, MarketDisplay } from "@/types/trading";

interface MarketHeaderProps {
  dayStats?: MarketDayStats;
  loading?: boolean;
  selectedMarket: MarketDisplay;
}

interface HeaderMetric {
  label: string;
  value: string | null;
  description: string;
  updating?: boolean;
  tone?: "positive" | "negative";
}

function fundingMetric(market: MarketDisplay): HeaderMetric {
  const funding = market.funding;
  if (!funding) return {
    label: "Est. funding",
    value: market.fundingRate !== null && Number.isFinite(market.fundingRate) ? formatPct(market.fundingRate, 4) : null,
    description: "Estimated payment between long and short positions.",
  };
  const interval = funding.intervalMs;
  const period = interval > 0 && Number.isFinite(interval)
    ? interval % 3_600_000 === 0 ? `${interval / 3_600_000}h`
      : interval % 60_000 === 0 ? `${interval / 60_000}m` : `${interval / 1_000}s`
    : undefined;
  const settling = funding.settlementStatus === "running";
  const settlement = settling ? "" : " Funding payments are paused.";
  const description = funding.status === "ready" ? "Estimated payment between long and short positions."
    : funding.status === "warming" || funding.status === "stale" ? "Updating the funding estimate."
      : "More buy and sell liquidity is needed to calculate funding.";
  return {
    label: `${settling ? "Funding" : "Est. funding"}${period ? ` · ${period}` : ""}`,
    value: funding.status === "ready" && funding.rate !== null && Number.isFinite(funding.rate)
      ? formatPct(funding.rate, 4) : null,
    description: `${description}${settlement}`,
  };
}

function openInterestMetric(market: MarketDisplay, loading: boolean): HeaderMetric {
  const available = market.openInterestDetails?.status === "available" &&
    market.openInterest !== null && Number.isFinite(market.openInterest) && market.openInterest >= 0;
  if (!available) return {
    label: "Open interest",
    value: market.openInterestDetails?.status === "incomplete" || !loading ? "—" : null,
    description: "Updating the total size of open positions.",
  };
  const size = market.openInterest!;
  return {
    label: "Open interest",
    value: `${formatCompact(size)} ${market.baseAsset}`,
    description: `Total open ${market.baseAsset} position size, counting each matched pair once.`,
  };
}

export function MarketHeader({ dayStats, loading = false, selectedMarket }: MarketHeaderProps) {
  const markPrice = selectedMarket.markPrice;
  const priceDigits = markPrice !== undefined && markPrice < 10 ? 5 : 2;
  const reference = dayStats?.marketId === selectedMarket.marketId ? dayStats : undefined;
  const referenceDescription = reference
    ? `24h reference prices from Hyperliquid. Updated ${new Date(reference.asOf).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.${reference.stale ? " Refreshing." : ""}`
    : "Loading 24h reference prices from Hyperliquid.";
  const stats: HeaderMetric[] = [
    {
      label: "24h change",
      value: reference ? formatPct(reference.change24h, 2) : null,
      description: referenceDescription,
      updating: reference?.stale,
      tone: reference ? reference.change24h < 0 ? "negative" : reference.change24h > 0 ? "positive" : undefined : undefined,
    },
    {
      label: "24h high",
      value: reference ? `$${formatNumber(reference.high24h, reference.high24h < 10 ? 5 : 2)}` : null,
      description: referenceDescription,
    },
    {
      label: "24h low",
      value: reference ? `$${formatNumber(reference.low24h, reference.low24h < 10 ? 5 : 2)}` : null,
      description: referenceDescription,
    },
    fundingMetric(selectedMarket),
    openInterestMetric(selectedMarket, loading),
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
                {stat.value ?? <LoadingDots label={`Loading ${stat.label}`} />}
                {stat.updating ? <LoadingDots label="Updating 24h market data" /> : null}
              </strong>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
