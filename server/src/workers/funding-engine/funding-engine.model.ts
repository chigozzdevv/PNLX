import type { FundingUpdateRecord } from "@merkl/protocol-types";

export interface FundingEngineConfig {
  intervalMs: number;
  maxFundingDelta?: bigint;
  premiumRate: bigint;
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

export interface FundingCycleResult {
  appliedAt: number;
  results: FundingCycleMarketResult[];
}
