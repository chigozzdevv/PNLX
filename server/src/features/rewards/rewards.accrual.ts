import { ownerCommitment } from "@pnlx/crypto";
import type { Hex } from "@pnlx/protocol-types";
import { confirmedFills, PointsService, settlementTouchesOwners } from "@/features/points/points.service";
import { FEE_CONFIG_HASH } from "@/shared/protocol/fee-config";
import type { ProtocolStore } from "@/shared/state/store";
import type { ReferralAttribution } from "@/features/rewards/rewards.referrals";

export interface RewardAccrual {
  rebate: bigint;
  referral: bigint;
  eligibleTreasuryFees: bigint;
  complete: boolean;
}

export class RewardAccrualService {
  private readonly points: PointsService;
  private readonly operator?: Hex;

  constructor(private readonly store: ProtocolStore, makerAddress?: string) {
    this.points = new PointsService(store, makerAddress);
    this.operator = makerAddress ? ownerCommitment(makerAddress.trim().toUpperCase()) : undefined;
  }

  forOwner(owner: Hex, referrals: ReferralAttribution[] = [], now = Date.now()): RewardAccrual {
    let rebate = 0n;
    let referral = 0n;
    let eligibleTreasuryFees = 0n;
    let complete = true;
    if (owner === this.operator) return { rebate, referral, eligibleTreasuryFees, complete };
    const seen = new Set<Hex>();
    const ownerOnly = new Set([owner]);
    for (const settlement of this.store.settlements.values()) {
      if (!settlement.onchainConfirmed || seen.has(settlement.settlementDigest)) continue;
      const settledAt = this.store.marketSettlementVolumes.get(settlement.settlementDigest)?.settledAt;
      const relatedOwners = new Set([owner, ...referrals.filter((entry) => entry.referrer === owner &&
        entry.registeredAt < (settledAt ?? now)).map((entry) => entry.referred)]);
      if (!settlementTouchesOwners(settlement, this.store, relatedOwners)) continue;
      seen.add(settlement.settlementDigest);
      if (settlement.feeConfigHash !== FEE_CONFIG_HASH) { complete = false; continue; }
      if (settledAt === undefined) { complete = false; continue; }
      if (settledAt > now) continue;
      const fills = confirmedFills(settlement, this.store);
      if (!fills) { complete = false; continue; }
      if (!settlementTouchesOwners(settlement, this.store, ownerOnly) &&
        !fills.some((fill) => fill.maker !== owner && referrals.some((entry) => entry.referrer === owner &&
          entry.referred === fill.taker && entry.registeredAt < settledAt))) continue;
      const tier = this.points.snapshot(owner, settledAt - 1);
      if (!tier.complete) { complete = false; continue; }
      const rate = tier.benefits.feeRebatePercent;
      const referralRate = tier.benefits.referralSharePercent;
      for (const fill of fills) {
        if (fill.maker === fill.taker) continue;
        if (fill.taker === owner) {
          eligibleTreasuryFees += fill.treasuryFee;
          rebate += percentage(fill.grossTakerFee, rate);
        }
        if (fill.maker !== owner && referrals.some((entry) => entry.referrer === owner &&
          entry.referred === fill.taker && entry.registeredAt < settledAt)) {
          referral += percentage(fill.treasuryFee, referralRate);
        }
      }
    }
    return { rebate, referral, eligibleTreasuryFees, complete };
  }
}

function percentage(amount: bigint, percent: number): bigint {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new Error("Invalid reward percentage");
  return amount * BigInt(Math.round(percent * 100)) / 10_000n;
}
