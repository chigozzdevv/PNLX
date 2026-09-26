export type PointsTier = "Standard" | "Silver" | "Gold" | "Platinum";

export interface TierBenefit {
  tier: PointsTier;
  threshold: number;
  feeRebatePercent: number;
  referralSharePercent: number;
  creditDropWeight: number;
}

export const TIER_BENEFITS: readonly TierBenefit[] = [
  { tier: "Standard", threshold: 0, feeRebatePercent: 0, referralSharePercent: 0, creditDropWeight: 1 },
  { tier: "Silver", threshold: 250, feeRebatePercent: 5, referralSharePercent: 5, creditDropWeight: 1.5 },
  { tier: "Gold", threshold: 1_000, feeRebatePercent: 10, referralSharePercent: 7.5, creditDropWeight: 2 },
  { tier: "Platinum", threshold: 3_000, feeRebatePercent: 15, referralSharePercent: 10, creditDropWeight: 3 },
] as const;

export interface PointsDay {
  date: string;
  makerNotional: string;
  points: number;
  takerNotional: string;
}

export interface PointsSnapshot {
  activePoints: number;
  benefits: TierBenefit;
  complete: boolean;
  days: PointsDay[];
  lifetimePoints: number;
  nextTier: TierBenefit | null;
  tier: PointsTier;
}
