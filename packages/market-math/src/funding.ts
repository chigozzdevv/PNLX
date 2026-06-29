import { PRICE_SCALE, RATE_SCALE } from "./constants";

export function fundingPayment(signedSize: bigint, currentIndex: bigint, lastIndex: bigint): bigint {
  return signedSize * (currentIndex - lastIndex);
}

export interface FundingIndexDeltaInput {
  elapsedMs: number;
  intervalMs: number;
  markPrice: bigint;
  maxFundingDelta?: bigint;
  premiumRate: bigint;
}

export function fundingIndexDelta(input: FundingIndexDeltaInput): bigint {
  if (input.markPrice <= 0n) throw new Error("mark price must be positive");
  if (input.elapsedMs < 0) throw new Error("elapsed time cannot be negative");
  if (input.intervalMs <= 0) throw new Error("funding interval must be positive");
  if (input.maxFundingDelta !== undefined && input.maxFundingDelta < 0n) {
    throw new Error("max funding delta cannot be negative");
  }

  const raw =
    (input.markPrice * input.premiumRate * BigInt(Math.trunc(input.elapsedMs))) /
    (PRICE_SCALE * RATE_SCALE * BigInt(Math.trunc(input.intervalMs)));
  if (input.maxFundingDelta === undefined) return raw;
  if (raw > input.maxFundingDelta) return input.maxFundingDelta;
  if (raw < -input.maxFundingDelta) return -input.maxFundingDelta;
  return raw;
}
