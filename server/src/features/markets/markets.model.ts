import type { MarketConfig } from "@pnlx/protocol-types";

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

export type MarketCandleInterval = "1m" | "5m" | "15m" | "1h" | "1d";

export interface MarketCandlesInput {
  interval: MarketCandleInterval;
  limit: number;
  marketId: string;
}

export interface MarketCandle {
  close: number;
  high: number;
  low: number;
  open: number;
  time: string;
  volume: number;
}

export interface MarketTickerItem {
  change24h: number;
  marketId: string;
  openInterest: number;
  pair: string;
  price: number;
  source: string;
  volume24h: number;
}
