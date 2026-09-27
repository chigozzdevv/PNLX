import type { ClaimableRewardKind } from "@/features/rewards/rewards.model";

export function parseRewardClaim(input: Record<string, unknown>): ClaimableRewardKind {
  if (input.kind !== "rebate" && input.kind !== "referral") {
    throw new Error("Select a claimable reward");
  }
  return input.kind;
}

export function parseReferral(input: Record<string, unknown>): string {
  if (typeof input.referrer !== "string" || !/^G[A-Z2-7]{55}$/.test(input.referrer)) {
    throw new Error("Enter a valid referrer wallet address");
  }
  return input.referrer;
}
