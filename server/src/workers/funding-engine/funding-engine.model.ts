import type { FundingPremiumSampleRecord, FundingUpdateRecord } from "@pnlx/protocol-types";

export type FundingPremiumMode = "fixed" | "impact-twap";

export interface FundingEngineConfig {
  impactMargin?: bigint;
  intervalMs: number;
  maxFundingDelta?: bigint;
  minimumSamples?: number;
  premiumMode?: FundingPremiumMode;
  premiumRate: bigint;
  premiumRateCap?: bigint;
  sampleIntervalMs?: number;
  settlementsOnchainRequired?: boolean;
}

export interface RunFundingCycleInput {
  appliedAt?: number;
  elapsedMs?: number;
  marketId?: string;
  maxFundingDelta?: bigint;
  premiumRate?: bigint;
}

export interface FundingCycleMarketResult {
  elapsedMs: number;
  marketId: string;
  reason?: string;
  skipped: boolean;
  update?: FundingUpdateRecord;
}

export interface FundingPremiumSampleResult {
  record: FundingPremiumSampleRecord;
}

export interface FundingCycleResult {
  appliedAt: number;
  results: FundingCycleMarketResult[];
}
