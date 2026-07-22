import type { Hex } from "@pnlx/protocol-types";
import type {
  MarketCandlesInput,
  MarketCandleInterval,
  CreateMarketInput,
  CreateOracleMarketInput,
  RefreshOracleMarketInput,
  UpdateMarketInput,
} from "@/features/markets/markets.model";

export function parseMarket(input: Record<string, string | number>): CreateMarketInput {
  return {
    marketId: String(input.marketId),
    oraclePrice: BigInt(input.oraclePrice),
    maxLeverage: BigInt(input.maxLeverage),
    initialMarginRate: BigInt(input.initialMarginRate),
    maintenanceMarginRate: BigInt(input.maintenanceMarginRate),
    fundingIndex: BigInt(input.fundingIndex),
  };
}

export const parseMarketUpdate = parseMarket as (
  input: Record<string, string | number>,
) => UpdateMarketInput;

export function parseOracleMarket(
  input: Record<string, string | number | undefined>,
): CreateOracleMarketInput {
  return {
    feedId: input.feedId ? (String(input.feedId) as Hex) : undefined,
    fundingIndex: BigInt(input.fundingIndex ?? 0),
    initialMarginRate: BigInt(requiredValue(input.initialMarginRate, "initialMarginRate")),
    maintenanceMarginRate: BigInt(requiredValue(input.maintenanceMarginRate, "maintenanceMarginRate")),
    marketId: String(input.marketId),
    maxLeverage: BigInt(requiredValue(input.maxLeverage, "maxLeverage")),
  };
}

export function parseOracleRefresh(
  input: Record<string, string | number | undefined>,
): RefreshOracleMarketInput {
  return {
    feedId: input.feedId ? (String(input.feedId) as Hex) : undefined,
    marketId: String(input.marketId),
  };
}

export function parseMarketCandles(request: Request): MarketCandlesInput {
  const params = new URL(request.url).searchParams;
  const marketId = params.get("marketId")?.trim();
  if (!marketId) throw new Error("marketId is required");

  return {
    interval: parseInterval(params.get("interval") ?? "1m"),
    limit: parseLimit(params.get("limit") ?? "120"),
    marketId,
  };
}

export function parseMarketPriceStream(request: Request): string {
  const marketId = new URL(request.url).searchParams.get("marketId")?.trim();
  if (!marketId) throw new Error("marketId is required");
  return marketId;
}

function parseInterval(value: string): MarketCandleInterval {
  if (value === "1m" || value === "5m" || value === "15m" || value === "1h" || value === "1d") {
    return value;
  }
  throw new Error("unsupported candle interval");
}

function parseLimit(value: string): number {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) throw new Error("invalid candle limit");
  return Math.min(limit, 300);
}

function requiredValue(value: string | number | undefined, field: string): string | number {
  if (value === undefined) throw new Error(`${field} is required`);
  return value;
}
