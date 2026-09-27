import type { Hex } from "@pnlx/protocol-types";
import { PointsService } from "@/features/points/points.service";
import type { PointsTier } from "@/features/points/points.model";
import type { ProtocolStore } from "@/shared/state/store";

const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;
const TIER_WEIGHTS: Record<PointsTier, bigint> = {
  Standard: 2n,
  Silver: 3n,
  Gold: 4n,
  Platinum: 6n,
};

export interface WeeklyCreditDropShare {
  ownerCommitment: Hex;
  activePoints: number;
  tier: PointsTier;
  amount: bigint;
}

export function allocateWeeklyCreditDrops(input: {
  store: ProtocolStore;
  budget: bigint;
  weekStart: number;
  now: number;
  makerAddress?: string;
}): WeeklyCreditDropShare[] {
  const { budget, weekStart, now, store } = input;
  if (budget < 0n || budget >= (1n << 128n)) throw new Error("Invalid Credit Drop budget");
  if (!Number.isSafeInteger(weekStart) || weekStart < 0 ||
    new Date(weekStart).getUTCDay() !== 1 || weekStart % 86_400_000 !== 0) {
    throw new Error("Credit Drop week must start on Monday UTC");
  }
  if (!Number.isSafeInteger(now) || now < weekStart + WEEK_MS) {
    throw new Error("Credit Drop week is not complete");
  }
  if (budget === 0n) return [];

  const owners = new Set<Hex>();
  for (const position of store.positionLifecycle.values()) {
    if (position.status !== "closed" || !position.closeCommitment ||
      position.updatedAt < weekStart || position.updatedAt >= weekStart + WEEK_MS) continue;
    if (!store.positionCloses.get(position.closeCommitment)?.settlementTxHash) continue;
    owners.add(position.ownerCommitment);
  }

  const points = new PointsService(store, input.makerAddress);
  const weighted = [...owners].sort().map((ownerCommitment) => {
    const snapshot = points.snapshot(ownerCommitment, weekStart + WEEK_MS - 1);
    if (!snapshot.complete) throw new Error("Credit Drop points are not reconciled");
    return {
      ownerCommitment,
      activePoints: snapshot.activePoints,
      tier: snapshot.tier,
      weight: BigInt(snapshot.activePoints) * TIER_WEIGHTS[snapshot.tier],
    };
  }).filter((entry) => entry.weight > 0n);
  const totalWeight = weighted.reduce((sum, entry) => sum + entry.weight, 0n);
  if (totalWeight === 0n) return [];

  const shares = weighted.map((entry) => {
    const numerator = budget * entry.weight;
    return { ...entry, amount: numerator / totalWeight, remainder: numerator % totalWeight };
  });
  let undistributed = budget - shares.reduce((sum, entry) => sum + entry.amount, 0n);
  for (const entry of [...shares].sort((a, b) =>
    a.remainder === b.remainder ? a.ownerCommitment.localeCompare(b.ownerCommitment) :
      a.remainder > b.remainder ? -1 : 1)) {
    if (undistributed === 0n) break;
    entry.amount += 1n;
    undistributed -= 1n;
  }
  return shares.filter((entry) => entry.amount > 0n).map(({ ownerCommitment, activePoints, tier, amount }) =>
    ({ ownerCommitment, activePoints, tier, amount }));
}
