import {
  circuitPositionCommitment,
  circuitPositionNullifier,
  digestToFieldHex,
} from "@pnlx/crypto";
import { fillFees } from "@pnlx/market-math";
import type {
  AccountEventRecord,
  BatchSettlement,
  Hex,
  PositionLifecycleRecord,
  PrivateMatchIntent,
  Side,
} from "@pnlx/protocol-types";
import { createPositionOpeningAccountEvent } from "@/shared/protocol/account-event-outcomes";
import type { ProtocolStore } from "@/shared/state/store";

type PositionOpeningPayload = Parameters<typeof createPositionOpeningAccountEvent>[1];

interface BookState {
  allocatedMargin: bigint;
  filled: bigint;
  intent: PrivateMatchIntent;
  remaining: bigint;
  side: Side;
  size: bigint;
}

export interface AccountKeyRecoverySkip {
  positionCommitment: Hex;
  reason: string;
}

export interface AccountKeyRecovery {
  events: AccountEventRecord[];
  skipped: AccountKeyRecoverySkip[];
}

export function recoverPositionOpeningEventsForOwner(
  store: ProtocolStore,
  ownerCommitment: Hex,
  publicKey: string,
): AccountKeyRecovery {
  const positions = store.positionsFor(ownerCommitment)
    .filter((position) => position.status === "open");
  const settlements = new Map(
    [...store.settlements.values()].map((settlement) => [settlement.settlementDigest, settlement]),
  );
  const positionByCommitment = new Map(
    [...store.positionLifecycle.values()].map((position) => [position.positionCommitment, position]),
  );
  const groups = groupBy(positions, (position) => position.settlementDigest);
  const events: AccountEventRecord[] = [];
  const skipped: AccountKeyRecoverySkip[] = [];

  for (const [settlementDigest, ownerPositions] of groups) {
    const settlement = settlements.get(settlementDigest);
    if (!settlement) {
      for (const position of ownerPositions) {
        skipped.push({ positionCommitment: position.positionCommitment, reason: "missing settlement" });
      }
      continue;
    }

    const reconstructed = reconstructSettlementOpenings(settlement, positionByCommitment, store.privateMatchIntents);
    for (const position of ownerPositions) {
      const payload = reconstructed.get(position.positionCommitment);
      if (!payload) {
        skipped.push({
          positionCommitment: position.positionCommitment,
          reason: "opening payload could not be reconstructed",
        });
        continue;
      }

      events.push(createPositionOpeningAccountEvent(position, payload, publicKey));
    }
  }

  return { events, skipped };
}

function reconstructSettlementOpenings(
  settlement: BatchSettlement,
  positions: Map<Hex, PositionLifecycleRecord>,
  privateMatchIntents: Map<Hex, PrivateMatchIntent>,
): Map<Hex, PositionOpeningPayload> {
  const out = new Map<Hex, PositionOpeningPayload>();
  const state = new Map<Hex, BookState>();

  for (let index = 0; index < settlement.newCommitments.length; index += 2) {
    const left = positions.get(settlement.newCommitments[index]);
    const right = positions.get(settlement.newCommitments[index + 1]);
    if (!left || !right) continue;

    const leftState = stateFor(left.sourceIntentCommitment, privateMatchIntents, state);
    const rightState = stateFor(right.sourceIntentCommitment, privateMatchIntents, state);
    if (!leftState || !rightState || leftState.side === rightState.side) continue;

    const long = leftState.side === "long" ? leftState : rightState;
    const short = leftState.side === "short" ? leftState : rightState;
    const maker = settlement.makerIntents?.[index / 2];
    const taker = settlement.takerIntents?.[index / 2];
    const feeBearing = maker && taker &&
      [left.sourceIntentCommitment, right.sourceIntentCommitment].includes(maker) &&
      [left.sourceIntentCommitment, right.sourceIntentCommitment].includes(taker) && maker !== taker;
    if (!feeBearing && (settlement.grossTakerFee ?? 0n) !== 0n) continue;
    if (long.intent.limitPrice < short.intent.limitPrice ||
      (!feeBearing && long.intent.limitPrice !== short.intent.limitPrice)) continue;
    const size = minBigInt(long.remaining, short.remaining);
    const price = feeBearing
      ? maker === long.intent.intentCommitment ? long.intent.limitPrice : short.intent.limitPrice
      : long.intent.limitPrice;
    const fees = feeBearing ? fillFees(size, price) : undefined;
    const leftEntryFee = fees
      ? left.sourceIntentCommitment === maker ? -fees.makerRebate : fees.grossTakerFee : 0n;
    const rightEntryFee = fees
      ? right.sourceIntentCommitment === maker ? -fees.makerRebate : fees.grossTakerFee : 0n;
    const leftMargin = allocateMargin(leftState, size) - leftEntryFee;
    const rightMargin = allocateMargin(rightState, size) - rightEntryFee;

    addIfValid(out, left, {
      ...(fees ? { entryFee: leftEntryFee } : {}),
      entryPrice: price,
      fundingIndex: 0n,
      margin: leftMargin,
      marketId: left.marketId,
      positionCommitment: left.positionCommitment,
      positionNullifier: left.positionNullifier,
      side: leftState.side,
      size,
      sourceIntentCommitment: left.sourceIntentCommitment,
    }, index);
    addIfValid(out, right, {
      ...(fees ? { entryFee: rightEntryFee } : {}),
      entryPrice: price,
      fundingIndex: 0n,
      margin: rightMargin,
      marketId: right.marketId,
      positionCommitment: right.positionCommitment,
      positionNullifier: right.positionNullifier,
      side: rightState.side,
      size,
      sourceIntentCommitment: right.sourceIntentCommitment,
    }, index + 1);
  }

  return out;
}

function addIfValid(
  out: Map<Hex, PositionOpeningPayload>,
  position: PositionLifecycleRecord,
  payload: PositionOpeningPayload,
  fillIndex: number,
): void {
  if (!matchesPosition(position, payload, fillIndex)) return;
  out.set(position.positionCommitment, payload);
}

function stateFor(
  intentCommitment: Hex,
  privateMatchIntents: Map<Hex, PrivateMatchIntent>,
  state: Map<Hex, BookState>,
): BookState | undefined {
  const existing = state.get(intentCommitment);
  if (existing) return existing;
  const intent = privateMatchIntents.get(intentCommitment);
  if (!intent) return undefined;
  const side: Side = intent.signedSize >= 0n ? "long" : "short";
  const size = intent.signedSize >= 0n ? intent.signedSize : -intent.signedSize;
  const created = {
    allocatedMargin: 0n,
    filled: 0n,
    intent,
    remaining: size,
    side,
    size,
  };
  state.set(intentCommitment, created);
  return created;
}

function allocateMargin(order: BookState, fillSize: bigint): bigint {
  const nextFilled = order.filled + fillSize;
  const nextAllocatedMargin = ceilDiv(order.intent.margin * nextFilled, order.size);
  const fillMargin = nextAllocatedMargin - order.allocatedMargin;
  order.filled = nextFilled;
  order.remaining -= fillSize;
  order.allocatedMargin = nextAllocatedMargin;
  return fillMargin;
}

function matchesPosition(
  position: PositionLifecycleRecord,
  payload: PositionOpeningPayload,
  fillIndex: number,
): boolean {
  const marketDigest = digestToFieldHex(`market:${payload.marketId}`);
  const ownerDigest = digestToFieldHex(`owner:${position.ownerCommitment}`);
  const rho = `${payload.sourceIntentCommitment}:position:${fillIndex}`;
  const rhoDigest = digestToFieldHex(`rho:${rho}`);
  const blinding = digestToFieldHex(`blinding:${payload.sourceIntentCommitment}:blinding:${fillIndex}`);
  const spendSecretDigest = digestToFieldHex(`spend:${position.ownerCommitment}:${rho}`);
  const commitment = circuitPositionCommitment({
    blinding,
    entryPrice: payload.entryPrice,
    fundingIndex: payload.fundingIndex,
    margin: payload.margin,
    marketDigest,
    ownerDigest,
    rhoDigest,
    side: payload.side,
    size: payload.size,
    spendSecretDigest,
  });
  const nullifier = circuitPositionNullifier({ rhoDigest, spendSecretDigest });
  return commitment === position.positionCommitment && nullifier === position.positionNullifier;
}

function groupBy<T, K extends string>(values: T[], keyFor: (value: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const value of values) {
    const key = keyFor(value);
    groups.set(key, [...(groups.get(key) ?? []), value]);
  }
  return groups;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function minBigInt(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}
