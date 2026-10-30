import type { MarketConfig } from "@pnlx/protocol-types";
import type { FundingEngineService } from "@/workers/funding-engine/funding-engine.service";
import type { MarketRiskFundingSnapshot } from "@/features/markets/market-risk-funding";

export type CreateMarketInput = MarketConfig;
export type UpdateMarketInput = MarketConfig;

export interface MarketSummary extends MarketConfig {
  fundingRate: bigint | null;
  funding: ReturnType<FundingEngineService["fundingSummary"]>;
  riskFunding: MarketRiskFundingSnapshot;
  openInterest: bigint | null;
  openInterestDetails: {
    status: "available" | "incomplete";
    reason?: string;
    updatedAt: number;
    convention: "half-gross-base";
    source: "pnlx-settled-exposure";
  };
  volume: bigint;
}

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

export type MarketCandleInterval = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

export interface MarketCandlesInput {
  from?: number;
  interval: MarketCandleInterval;
  limit: number;
  marketId: string;
  to?: number;
}

export interface MarketCandle {
  close: number;
  high: number;
  low: number;
  open: number;
  time: string;
  trades?: number;
  volume: number;
}

export interface MarketTickerItem {
  change24h: number;
  fundingRate: number | null;
  marketId: string;
  openInterest: number;
  pair: string;
  price: number;
  source: string;
  volume24h: number;
}

export interface MarketDayStats {
  marketId: string;
  source: "hyperliquid";
  interval: "1m";
  /** Inclusive start of the complete rolling window, in milliseconds. */
  from: number;
  /** Exclusive end at the latest closed minute, in milliseconds. */
  asOf: number;
  fetchedAt: number;
  change24h: number;
  high24h: number;
  low24h: number;
  open24h: number;
  lastPrice: number;
  stale: boolean;
}
