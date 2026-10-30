import { formatUsd } from "@/lib/format";
import { positionLegs } from "@/lib/position-groups";
import { currentPositionFundingIndex } from "@/lib/position-funding";
import type { MarketDisplay, PositionRow } from "@/types/trading";

const PRICE_SCALE = 100_000_000n;
const RATE_SCALE = 1_000_000n;
const MAX_PRICE = (1n << 128n) - 1n;

export type LiquidationEstimate = { status: "price"; price: number } | { status: "none" | "unavailable" };
type RiskMarket = Pick<MarketDisplay, "marketId" | "maintenanceMarginRate" | "fundingIndex" | "riskFunding">;

/** UI grouping never pools collateral: the first independent fill boundary is the row's estimate. */
export function estimatePositionLiquidation(
  position: PositionRow, market: RiskMarket | undefined, now = Date.now(),
): LiquidationEstimate {
  const legs = positionLegs(position);
  const side = legs[0]?.privateState?.side;
  if (!legs.length || !side || legs.some((leg) => leg.privateState?.side !== side || leg.marketId !== position.marketId)) {
    return { status: "unavailable" };
  }
  const estimates = legs.map((leg) => estimateFill(leg, market, now));
  if (estimates.some((estimate) => estimate.status === "unavailable")) return { status: "unavailable" };
  const prices = estimates.flatMap((estimate) => estimate.status === "price" ? [estimate.price] : []);
  if (!prices.length) return { status: "none" };
  return { status: "price", price: side === "short" ? Math.min(...prices) : Math.max(...prices) };
}

export function positionLiquidationDisplay(position: PositionRow, market?: RiskMarket) {
  const estimate = estimatePositionLiquidation(position, market);
  return {
    value: estimate.status === "price" ? formatUsd(estimate.price, {
      minimumFractionDigits: estimate.price < 1 ? 4 : 2, maximumFractionDigits: 8,
    }) : "—",
    title: estimate.status === "unavailable" ? "Private position details or current risk data are unavailable."
      : estimate.status === "none" ? "No positive liquidation threshold at the current funding index. Paired positions may still close when the counterparty is distressed."
        : `Estimate from committed margin, maintenance rate and the funding index.${positionLegs(position).length > 1 ? " Shows the first fill threshold; fills remain separately margined." : ""} Paired positions can close when either side is distressed.`,
  };
}

function estimateFill(position: PositionRow, market: RiskMarket | undefined, now: number): LiquidationEstimate {
  const opening = position.privateState;
  if (!opening || position.privateDetails || !market || market.marketId !== position.marketId) return { status: "unavailable" };
  const size = integer(opening.size), entry = integer(opening.entryPrice), margin = integer(opening.margin);
  const entryIndex = integer(opening.fundingIndex, true);
  const currentIndex = currentPositionFundingIndex(market, now);
  const rawRate = Math.round(market.maintenanceMarginRate * Number(RATE_SCALE));
  const rate = Number.isSafeInteger(rawRate) ? BigInt(rawRate) : null;
  if (size === null || size <= 0n || entry === null || entry <= 0n || margin === null || margin < 0n ||
    entryIndex === null || currentIndex === undefined || rate === null || rate <= 0n || rate >= RATE_SCALE ||
    (opening.side !== "long" && opening.side !== "short")) return { status: "unavailable" };

  const direction = opening.side === "long" ? 1n : -1n;
  const funding = direction * size * (currentIndex - entryIndex) / PRICE_SCALE;
  // Opening margin already includes the actual entry fee or rebate.
  const availableMargin = margin - funding;
  let price: bigint;
  if (opening.side === "long") {
    const numerator = (size * entry - availableMargin * PRICE_SCALE) * RATE_SCALE;
    if (numerator <= 0n) return { status: "none" };
    const denominator = size * (RATE_SCALE - rate);
    // Independent integer truncations can make long risk non-monotone at tiny
    // units. Keep this a labelled estimate, rounded toward the earlier boundary.
    price = (numerator + denominator - 1n) / denominator;
  } else {
    const distressed = (mark: bigint) => {
      const equity = margin + size * (entry - mark) / PRICE_SCALE - funding;
      const maintenance = (size * mark / PRICE_SCALE) * rate / RATE_SCALE;
      return equity <= 0n || equity < maintenance;
    };
    let low = 1n, high = entry;
    while (!distressed(high) && high < MAX_PRICE) high = high > MAX_PRICE / 2n ? MAX_PRICE : high * 2n;
    if (!distressed(high)) return { status: "unavailable" };
    while (low < high) {
      const middle = (low + high) / 2n;
      if (distressed(middle)) high = middle;
      else low = middle + 1n;
    }
    price = low;
  }
  if (price <= 0n || price > MAX_PRICE) return { status: "unavailable" };
  const display = Number(price) / Number(PRICE_SCALE);
  return Number.isFinite(display) && display > 0 ? { status: "price", price: display } : { status: "unavailable" };
}

function integer(value: unknown, signed = false): bigint | null {
  if (typeof value !== "string" || !(signed ? /^-?\d+$/ : /^\d+$/).test(value)) return null;
  try {
    const parsed = BigInt(value);
    return parsed <= MAX_PRICE && parsed >= (signed ? -MAX_PRICE : 0n) ? parsed : null;
  } catch { return null; }
}
