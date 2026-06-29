import type { Hex } from "@merkl/protocol-types";
import type {
  CreateMarketInput,
  CreateOracleMarketInput,
  RefreshOracleMarketInput,
  UpdateMarketInput,
} from "./markets.model";

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
    initialMarginRate: BigInt(input.initialMarginRate),
    maintenanceMarginRate: BigInt(input.maintenanceMarginRate),
    marketId: String(input.marketId),
    maxLeverage: BigInt(input.maxLeverage),
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
