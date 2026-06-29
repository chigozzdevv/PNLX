import type { FundingUpdateRecord } from "@merkl/protocol-types";
import type { FundingCycleResult } from "../../workers/funding-engine/funding-engine.model";

export interface AdvanceFundingInput {
  appliedAt?: number;
  fundingDelta: bigint;
  marketId: string;
}

export type AdvanceFundingResult = FundingUpdateRecord;

export interface RunFundingInput {
  appliedAt?: number;
  elapsedMs?: number;
  marketId?: string;
  maxFundingDelta?: bigint;
  premiumRate?: bigint;
}

export type RunFundingResult = FundingCycleResult;
