import type { MarketDisplay, PositionRow } from "@/types/trading";
import { protocolUsdcToDisplay } from "@/lib/asset-units";

const PRICE_SCALE = 100_000_000n;
const MAX_AGE_MS = 60_000;
const MAX_INDEX = (1n << 127n) - 1n;
type FundingMarket = Pick<MarketDisplay, "fundingIndex" | "riskFunding">;
type FundingOpening = Pick<NonNullable<PositionRow["privateState"]>, "size" | "side" | "fundingIndex">;
type ValuationOpening = FundingOpening & Pick<NonNullable<PositionRow["privateState"]>, "entryPrice" | "entryFee" | "margin">;

export function currentPositionFundingIndex(market: FundingMarket | undefined, now = Date.now()): bigint | undefined {
  if (!market) return undefined;
  const snapshot = market.riskFunding;
  if (snapshot !== undefined) {
    if (!snapshot || typeof snapshot !== "object" || snapshot.status !== "available" ||
      (snapshot.source !== "onchain-market" && snapshot.source !== "market-config") ||
      !Number.isSafeInteger(snapshot.updatedAt) || snapshot.updatedAt === null ||
      now - snapshot.updatedAt > MAX_AGE_MS || snapshot.updatedAt > now + 5_000) return undefined;
    return fundingIndex(snapshot.fundingIndex);
  }
  // Older responses explicitly supplied a settled/configured index. Missing is never zero.
  return fundingIndex(market.fundingIndex);
}

/** Positive means funding owed by the position; negative means a funding credit. */
export function positionFundingPayment(
  opening: FundingOpening | undefined, market: FundingMarket | undefined, now = Date.now(),
): bigint | undefined {
  if (!opening || (opening.side !== "long" && opening.side !== "short") || !/^\d+$/.test(opening.size)) return undefined;
  const previous = fundingIndex(opening.fundingIndex), current = currentPositionFundingIndex(market, now);
  if (previous === undefined || current === undefined) return undefined;
  const size = BigInt(opening.size);
  if (size <= 0n || size >= 1n << 128n) return undefined;
  return (opening.side === "long" ? 1n : -1n) * size * (current - previous) / PRICE_SCALE;
}

/** Committed margin is already net of the entry fee; net PnL includes that fee once. */
export function positionValuation(
  opening: ValuationOpening | undefined, markPrice: bigint | undefined,
  market: FundingMarket | undefined, now = Date.now(),
): Pick<PositionRow, "fundingPayment" | "unrealizedPnl" | "netValue"> {
  const funding = positionFundingPayment(opening, market, now);
  const fundingPayment = funding === undefined ? undefined : protocolUsdcToDisplay(funding);
  if (!opening || funding === undefined || markPrice === undefined || markPrice <= 0n ||
    !/^\d+$/.test(opening.entryPrice) || !/^\d+$/.test(opening.margin) ||
    !/^-?\d+$/.test(opening.entryFee ?? "0")) {
    return { fundingPayment, unrealizedPnl: undefined, netValue: undefined };
  }
  const size = BigInt(opening.size), entry = BigInt(opening.entryPrice);
  if (entry <= 0n) return { fundingPayment, unrealizedPnl: undefined, netValue: undefined };
  const delta = opening.side === "long" ? markPrice - entry : entry - markPrice;
  const grossPnl = size * delta / PRICE_SCALE;
  return {
    fundingPayment,
    unrealizedPnl: protocolUsdcToDisplay(grossPnl - BigInt(opening.entryFee ?? "0") - funding),
    netValue: protocolUsdcToDisplay(BigInt(opening.margin) + grossPnl - funding),
  };
}

function fundingIndex(value: unknown): bigint | undefined {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) return undefined;
  const index = BigInt(value);
  return index <= MAX_INDEX && index >= -MAX_INDEX - 1n ? index : undefined;
}
