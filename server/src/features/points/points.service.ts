import { ownerCommitment } from "@pnlx/crypto";
import { fillFees, notional } from "@pnlx/market-math";
import type { BatchSettlement, Hex, PrivateMatchIntent } from "@pnlx/protocol-types";
import { FEE_CONFIG_HASH } from "@/shared/protocol/fee-config";
import type { ProtocolStore } from "@/shared/state/store";
import { TIER_BENEFITS, type PointsDay, type PointsSnapshot } from "@/features/points/points.model";
import { assertPrivateMatchIntent, matchingPayloadCommitment } from "@/workers/batch-matcher/private-intent";

const USDC_SCALE = 10_000_000n;
const POINT_NOTIONAL = 10n * USDC_SCALE;
const WINDOW_MS = 90 * 24 * 60 * 60 * 1_000;
const DAILY_LIMIT = 100;

interface DayValue {
  makerNotional: bigint;
  takerNotional: bigint;
  cycles: number;
  weeklyBonus: boolean;
}

export class PointsService {
  constructor(private readonly store: ProtocolStore, private readonly makerAddress?: string) {}

  snapshot(owner: Hex, now = Date.now()): PointsSnapshot {
    const daily = new Map<string, DayValue>();
    let complete = true;
    const operator = this.makerAddress ? ownerCommitment(this.makerAddress.trim().toUpperCase()) : undefined;
    for (const settlement of this.store.settlements.values()) {
      if (!settlement.onchainConfirmed) continue;
      if (settlement.feeConfigHash !== FEE_CONFIG_HASH) {
        complete = false;
        continue;
      }
      const settledAt = this.store.marketSettlementVolumes.get(settlement.settlementDigest)?.settledAt;
      if (settledAt === undefined) {
        complete = false;
        continue;
      }
      if (settledAt > now) continue;
      const fills = confirmedFills(settlement, this.store);
      if (!fills) {
        complete = false;
        continue;
      }
      const day = dayKey(settledAt);
      for (const fill of fills) {
        if (fill.maker === fill.taker) continue;
        if (fill.taker === owner && owner !== operator) getDay(daily, day).takerNotional += fill.notional;
        if (fill.maker === owner && owner !== operator) getDay(daily, day).makerNotional += fill.notional;
      }
    }

    if (owner !== operator) {
      const activeWeeks = new Set<string>();
      const positions = [...this.store.positionLifecycle.values()].sort((a, b) => a.updatedAt - b.updatedAt);
      for (const position of positions) {
        if (position.ownerCommitment !== owner || position.status !== "closed" || !position.closeCommitment) continue;
        const close = this.store.positionCloses.get(position.closeCommitment);
        if (!close?.settlementTxHash || position.updatedAt > now) continue;
        const day = dayKey(position.updatedAt);
        getDay(daily, day).cycles += 1;
        const week = weekKey(position.updatedAt);
        if (!activeWeeks.has(week)) {
          activeWeeks.add(week);
          getDay(daily, day).weeklyBonus = true;
        }
      }
    }

    const days: PointsDay[] = [...daily.entries()]
      .map(([date, value]) => ({
        date,
        makerNotional: value.makerNotional.toString(),
        points: Math.min(DAILY_LIMIT, Number(min((value.makerNotional + value.takerNotional) / POINT_NOTIONAL, BigInt(DAILY_LIMIT))) +
          value.cycles * 10 + (value.weeklyBonus ? 5 : 0)),
        takerNotional: value.takerNotional.toString(),
      }))
      .sort((left, right) => right.date.localeCompare(left.date));
    const lifetimePoints = days.reduce((sum, day) => sum + day.points, 0);
    const windowStart = dayKey(now - WINDOW_MS + 86_400_000);
    const activePoints = days.filter((day) => day.date >= windowStart).reduce((sum, day) => sum + day.points, 0);
    const benefits = [...TIER_BENEFITS].reverse().find((entry) => activePoints >= entry.threshold)!;
    return {
      activePoints,
      benefits,
      complete,
      days,
      lifetimePoints,
      nextTier: TIER_BENEFITS.find((entry) => entry.threshold > activePoints) ?? null,
      tier: benefits.tier,
    };
  }
}

function confirmedFills(
  settlement: BatchSettlement,
  store: ProtocolStore,
): Array<{ maker: Hex; taker: Hex; notional: bigint }> | null {
  if (!Array.isArray(settlement.makerIntents) || !Array.isArray(settlement.takerIntents) ||
    !Array.isArray(settlement.matchingPayloadCommitments) ||
    settlement.makerIntents.length !== settlement.takerIntents.length) return null;
  const remaining = new Map<Hex, bigint>();
  const fills: Array<{ maker: Hex; taker: Hex; notional: bigint }> = [];
  let totalSize = 0n;
  let grossTakerFee = 0n;
  let makerRebate = 0n;
  let insurance = 0n;
  let treasury = 0n;
  for (let index = 0; index < settlement.makerIntents.length; index += 1) {
    const makerId = settlement.makerIntents[index];
    const takerId = settlement.takerIntents[index];
    const maker = store.privateMatchIntents.get(makerId);
    const taker = store.privateMatchIntents.get(takerId);
    if (!maker || !taker || makerId === takerId || maker.marketId !== settlement.marketId || taker.marketId !== settlement.marketId ||
      (maker.signedSize > 0n) === (taker.signedSize > 0n)) return null;
    if (!validIntent(store, maker) || !validIntent(store, taker)) return null;
    if (!settlement.matchingPayloadCommitments.includes(matchingPayloadCommitment(maker)) ||
      !settlement.matchingPayloadCommitments.includes(matchingPayloadCommitment(taker))) return null;
    const makerRemaining = remaining.get(makerId) ?? abs(maker.signedSize);
    const takerRemaining = remaining.get(takerId) ?? abs(taker.signedSize);
    const size = makerRemaining < takerRemaining ? makerRemaining : takerRemaining;
    if (size <= 0n) return null;
    remaining.set(makerId, makerRemaining - size);
    remaining.set(takerId, takerRemaining - size);
    totalSize += size;
    const fees = fillFees(size, maker.limitPrice);
    grossTakerFee += fees.grossTakerFee;
    makerRebate += fees.makerRebate;
    insurance += fees.insurance;
    treasury += fees.treasury;
    fills.push({ maker: maker.ownerCommitment, taker: taker.ownerCommitment, notional: notional(size, maker.limitPrice) });
  }
  return totalSize * 2n === settlement.aggregateVolume &&
    grossTakerFee === settlement.grossTakerFee && makerRebate === settlement.makerRebate &&
    insurance === settlement.insuranceFee && treasury === settlement.treasuryFee ? fills : null;
}

function getDay(days: Map<string, DayValue>, day: string): DayValue {
  let value = days.get(day);
  if (!value) {
    value = { makerNotional: 0n, takerNotional: 0n, cycles: 0, weeklyBonus: false };
    days.set(day, value);
  }
  return value;
}

function dayKey(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

function weekKey(at: number): string {
  const date = new Date(at);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 1 - day);
  return dayKey(date.getTime());
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function min(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function validIntent(store: ProtocolStore, payload: PrivateMatchIntent): boolean {
  const record = store.intents.get(payload.intentCommitment) ?? store.residualOrders.get(payload.intentCommitment);
  if (!record) return false;
  try {
    assertPrivateMatchIntent(record, payload);
    return true;
  } catch {
    return false;
  }
}
