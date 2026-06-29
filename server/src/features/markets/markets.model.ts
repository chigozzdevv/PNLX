import type { MarketConfig } from "@merkl/protocol-types";

export type CreateMarketInput = MarketConfig;
export type UpdateMarketInput = MarketConfig;

export interface CreateOracleMarketInput {
  feedId?: `0x${string}`;
  fundingIndex: bigint;
  initialMarginRate: bigint;
  maintenanceMarginRate: bigint;
  marketId: string;
  maxLeverage: bigint;
}

export interface RefreshOracleMarketInput {
  feedId?: `0x${string}`;
  marketId: string;
}
