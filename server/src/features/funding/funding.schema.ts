import type { AdvanceFundingInput, RunFundingInput } from "@/features/funding/funding.model";

type FundingBody = Record<string, unknown>;

export function parseAdvanceFunding(input: FundingBody): AdvanceFundingInput {
  return {
    appliedAt: input.appliedAt === undefined ? undefined : Number(input.appliedAt),
    fundingDelta: BigInt(String(input.fundingDelta)),
    marketId: String(input.marketId),
  };
}

export function parseRunFunding(input: FundingBody): RunFundingInput {
  return {
    appliedAt: input.appliedAt === undefined ? undefined : Number(input.appliedAt),
    elapsedMs: input.elapsedMs === undefined ? undefined : Number(input.elapsedMs),
    marketId: input.marketId === undefined ? undefined : String(input.marketId),
    maxFundingDelta: input.maxFundingDelta === undefined ? undefined : BigInt(String(input.maxFundingDelta)),
    premiumRate: input.premiumRate === undefined ? undefined : BigInt(String(input.premiumRate)),
  };
}
