import { hashFields } from "@pnlx/crypto";
import { fillFees, notional } from "@pnlx/market-math";
import type { BatchSettlement, Hex, PositionLifecycleRecord, PrivateMatchIntent, Side } from "@pnlx/protocol-types";
import { reconstructSettlementOpenings } from "@/features/account-keys/account-key-recovery";
import type { ProtocolStore } from "@/shared/state/store";
import { assertPrivateMatchIntent, matchingPayloadCommitment } from "@/workers/batch-matcher/private-intent";

export interface WalletTradedVolume {
  /** Lifetime matched notional in protocol USDC units (10^7), per executed wallet side. */
  amount: bigint | null;
  status: "available" | "incomplete";
  source: "pnlx-confirmed-fills";
}

/** Authenticated operator accounting; no individual fill or counterparty details leave the server. */
export function walletTradedVolume(store: ProtocolStore, owner: Hex): WalletTradedVolume {
  const result = (amount: bigint | null): WalletTradedVolume => ({
    amount, status: amount === null ? "incomplete" : "available", source: "pnlx-confirmed-fills",
  });
  const belongsToOwner = (value: { ownerCommitment: Hex }) =>
    typeof value.ownerCommitment === "string" && value.ownerCommitment.toLowerCase() === owner.toLowerCase();
  const ownerPositions = [...store.positionLifecycle.values()].filter(belongsToOwner);
  const positionIds = new Set(ownerPositions.map((position) => position.positionCommitment));
  const positionDigests = new Set(ownerPositions.map((position) => position.settlementDigest));
  const ownerOrders = new Set([
    ...[...store.intents.values()].filter(belongsToOwner).map((order) => order.intentCommitment),
    ...[...store.residualOrders.values()].filter(belongsToOwner).map((order) => order.intentCommitment),
    ...[...store.orderLifecycle.values()].filter(belongsToOwner).map((order) => order.intentCommitment),
  ]);
  const filledOrders = [...store.orderLifecycle.values()].filter((order) =>
    belongsToOwner(order) && (order.status === "filled" || order.status === "partially-filled"));
  const byDigest = new Map<Hex, BatchSettlement[]>();
  for (const settlement of store.settlements.values()) {
    const group = byDigest.get(settlement.settlementDigest) ?? [];
    group.push(settlement);
    byDigest.set(settlement.settlementDigest, group);
  }

  const coveredPositions = new Set<Hex>();
  const coveredOrders = new Set<Hex>();
  let amount = 0n;
  for (const [digest, aliases] of byDigest) {
    const relevant = positionDigests.has(digest) || aliases.some((settlement) =>
      Array.isArray(settlement.newCommitments) && settlement.newCommitments.some((commitment) => positionIds.has(commitment)) ||
      [...(Array.isArray(settlement.makerIntents) ? settlement.makerIntents : []),
        ...(Array.isArray(settlement.takerIntents) ? settlement.takerIntents : []),
        ...(Array.isArray(settlement.orderUpdates) ? settlement.orderUpdates : []).map((update) => update.intentCommitment)]
        .some((commitment) => ownerOrders.has(commitment)));
    if (!relevant) continue;
    try {
      const settlement = aliases[0];
      if (aliases.some((alias) => fingerprint(alias) !== fingerprint(settlement))) return result(null);
      if (settlement.onchainConfirmed !== true) return result(null);
      const { positions, legacy } = anchoredPositions(store, settlement);
      const openings = legacy ? legacyFillEconomics(store, settlement, positions)
        : reconstructSettlementOpenings(settlement, store.positionLifecycle, store.privateMatchIntents);
      let aggregateSize = 0n;
      for (const position of positions) {
        const opening = openings.get(position.positionCommitment);
        if (!opening || opening.size <= 0n || opening.entryPrice <= 0n ||
          (position.size !== undefined && position.size !== opening.size) ||
          (position.side !== undefined && position.side !== opening.side)) return result(null);
        aggregateSize += opening.size;
        if (!belongsToOwner(position)) continue;
        if (coveredPositions.has(position.positionCommitment)) return result(null);
        coveredPositions.add(position.positionCommitment);
        coveredOrders.add(position.sourceIntentCommitment);
        amount += notional(opening.size, opening.entryPrice);
      }
      if (aggregateSize !== settlement.aggregateVolume) return result(null);
    } catch {
      return result(null);
    }
  }
  if (ownerPositions.some((position) => !coveredPositions.has(position.positionCommitment)) ||
    filledOrders.some((order) => !coveredOrders.has(order.intentCommitment))) return result(null);
  return result(amount);
}

function anchoredPositions(store: ProtocolStore, settlement: BatchSettlement): { positions: PositionLifecycleRecord[]; legacy: boolean } {
  if (!Array.isArray(settlement.newCommitments) || settlement.newCommitments.length === 0 ||
    settlement.newCommitments.length % 2 !== 0 || settlement.fillCount !== settlement.newCommitments.length ||
    new Set(settlement.newCommitments).size !== settlement.newCommitments.length ||
    !Array.isArray(settlement.matchingPayloadCommitments) || settlement.aggregateVolume <= 0n) {
    throw new Error("invalid settled fill totals");
  }
  const formats = new Set<boolean>();
  const positions = settlement.newCommitments.map((commitment) => {
    const position = store.positionLifecycle.get(commitment);
    if (!position || position.positionCommitment !== commitment || position.marketId !== settlement.marketId ||
      position.batchId !== settlement.batchId || position.settlementDigest !== settlement.settlementDigest) {
      throw new Error("missing settled position history");
    }
    const payload = store.privateMatchIntents.get(position.sourceIntentCommitment);
    const record = store.intents.get(position.sourceIntentCommitment) ?? store.residualOrders.get(position.sourceIntentCommitment);
    if (!payload || !record || typeof payload.signedSize !== "bigint" || typeof payload.limitPrice !== "bigint" ||
      typeof payload.margin !== "bigint" || payload.signedSize === 0n || payload.limitPrice <= 0n || payload.margin <= 0n ||
      record.ownerCommitment !== position.ownerCommitment || record.marketId !== settlement.marketId) {
      throw new Error("missing settled matching payload");
    }
    const legacy = !Object.hasOwn(payload, "ownerDigest") && !Object.hasOwn(payload, "positionSeed");
    formats.add(legacy);
    if (legacy) {
      if (payload.intentCommitment !== record.intentCommitment || payload.marketId !== record.marketId ||
        payload.ownerCommitment !== record.ownerCommitment || payload.noteNullifier !== record.noteNullifier ||
        payload.noteChangeCommitment !== ("noteChangeCommitment" in record ? record.noteChangeCommitment : "0x0") ||
        ("sourceIntentCommitment" in record && payload.sourceIntentCommitment !== record.sourceIntentCommitment) ||
        legacyPayloadCommitment(payload) !== record.matchingPayloadCommitment) {
        throw new Error("legacy settled matching payload mismatch");
      }
    } else assertPrivateMatchIntent(record, payload);
    const binding = legacy ? legacyPayloadCommitment(payload) : matchingPayloadCommitment(payload);
    if (!settlement.matchingPayloadCommitments.includes(binding)) {
      throw new Error("unbound settled matching payload");
    }
    return position;
  });
  const pairs = positions.length / 2;
  const makers = settlement.makerIntents ?? [], takers = settlement.takerIntents ?? [];
  if (makers.length || takers.length) {
    if (makers.length !== pairs || takers.length !== pairs) throw new Error("invalid execution attribution");
    for (let index = 0; index < pairs; index++) {
      const sources = positions.slice(index * 2, index * 2 + 2).map((position) => position.sourceIntentCommitment);
      if (makers[index] === takers[index] || !sources.includes(makers[index]) || !sources.includes(takers[index])) {
        throw new Error("invalid execution attribution");
      }
    }
  }
  if (formats.size !== 1) throw new Error("mixed settled payload formats");
  return { positions, legacy: formats.has(true) };
}

/** Historical read adapter only; never used to admit or match new orders. */
function legacyPayloadCommitment(payload: PrivateMatchIntent): Hex {
  return hashFields("matching-payload", [payload.intentCommitment, payload.marketId, payload.ownerCommitment,
    payload.signedSize, payload.limitPrice, payload.margin, payload.noteNullifier, payload.noteChangeCommitment,
    payload.sourceIntentCommitment ?? "0x0"]);
}

function legacyFillEconomics(store: ProtocolStore, settlement: BatchSettlement, positions: PositionLifecycleRecord[]) {
  const fills = new Map<Hex, { size: bigint; entryPrice: bigint; side: Side }>();
  const remaining = new Map<Hex, bigint>();
  const totals = { grossTakerFee: 0n, makerRebate: 0n, insurance: 0n, treasury: 0n };
  for (let index = 0; index < positions.length; index += 2) {
    const long = store.privateMatchIntents.get(positions[index].sourceIntentCommitment)!;
    const short = store.privateMatchIntents.get(positions[index + 1].sourceIntentCommitment)!;
    // This historical matcher always appended the long output before the short output.
    if (long.signedSize <= 0n || short.signedSize >= 0n || long.limitPrice < short.limitPrice) {
      throw new Error("invalid legacy execution pair");
    }
    const longRemaining = remaining.get(long.intentCommitment) ?? long.signedSize;
    const shortRemaining = remaining.get(short.intentCommitment) ?? -short.signedSize;
    const size = longRemaining < shortRemaining ? longRemaining : shortRemaining;
    if (size <= 0n) throw new Error("repeated exhausted legacy fill");
    remaining.set(long.intentCommitment, longRemaining - size);
    remaining.set(short.intentCommitment, shortRemaining - size);
    const maker = settlement.makerIntents?.[index / 2];
    let price: bigint;
    if (maker) {
      price = maker === long.intentCommitment ? long.limitPrice : short.limitPrice;
      const fees = fillFees(size, price);
      for (const key of Object.keys(totals) as Array<keyof typeof totals>) totals[key] += fees[key];
    } else {
      if (long.limitPrice !== short.limitPrice) throw new Error("unknown legacy execution price");
      price = long.limitPrice;
    }
    fills.set(positions[index].positionCommitment, { size, entryPrice: price, side: "long" });
    fills.set(positions[index + 1].positionCommitment, { size, entryPrice: price, side: "short" });
  }
  if (totals.grossTakerFee !== (settlement.grossTakerFee ?? 0n) ||
    totals.makerRebate !== (settlement.makerRebate ?? 0n) ||
    totals.insurance !== (settlement.insuranceFee ?? 0n) || totals.treasury !== (settlement.treasuryFee ?? 0n)) {
    throw new Error("legacy settled fee totals mismatch");
  }
  return fills;
}

function fingerprint(settlement: BatchSettlement): string {
  return JSON.stringify([
    settlement.batchId, settlement.marketId, settlement.newCommitments, settlement.fillCount,
    settlement.matchingPayloadCommitments, settlement.makerIntents, settlement.takerIntents,
    settlement.aggregateVolume, settlement.grossTakerFee, settlement.makerRebate,
    settlement.insuranceFee, settlement.treasuryFee, settlement.feeConfigHash,
    settlement.matchTranscriptDigest, settlement.onchainConfirmed,
  ], (_key, value) => typeof value === "bigint" ? value.toString() : value);
}
