export type ClaimableRewardKind = "rebate" | "referral";

export interface RewardBalance {
  claimable: string;
  claimed: string;
  credited: string;
}

export interface RewardsAccount {
  contractId: string | null;
  rebate: RewardBalance | null;
  referral: RewardBalance | null;
  accrued: { rebate: string; referral: string } | null;
}

export interface PreparedRewardClaim {
  contractId: string;
  kind: ClaimableRewardKind;
  owner: string;
  txHash?: string;
  xdr: string;
}
