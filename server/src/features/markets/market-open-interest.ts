import { PRICE_SCALE } from "@pnlx/market-math";
import type { BatchSettlement, Hex, PositionLifecycleRecord, PrivateMatchIntent } from "@pnlx/protocol-types";
import type { ProtocolStore } from "@/shared/state/store";

type ExposureStore = Pick<ProtocolStore, "settlements" | "positionLifecycle" | "positionCommitments" | "privateMatchIntents" | "positionCloses" | "liquidations">;

export interface MarketOpenInterest {
  status: "available" | "incomplete";
  baseAmount: bigint | null;
  quoteAmount: bigint | null;
  grossBaseAmount: bigint | null;
  reason?: string;
  missingPositionCount: number;
  positionCount: number;
  source: "pnlx-settled-exposure";
  convention: "half-gross-base";
}

/** Operator accounting over committed positions, not a separate public aggregate proof. */
export function marketOpenInterest(
  store: ExposureStore,
  marketId: string,
  markPrice: bigint,
  options: { requireOnchainConfirmation?: boolean } = {},
): MarketOpenInterest {
  const metadata = { missingPositionCount: 0, positionCount: 0,
    source: "pnlx-settled-exposure" as const, convention: "half-gross-base" as const };
  const incomplete = (reason: string): MarketOpenInterest => ({
    ...metadata, status: "incomplete", baseAmount: null, quoteAmount: null, grossBaseAmount: null, reason,
  });
  const indexed = new Set<Hex>([
    ...store.positionLifecycle.keys(),
    ...[...store.settlements.values()].flatMap((settlement) => settlement.newCommitments),
    ...[...store.positionCloses.values()].flatMap((close) => [close.positionCommitment, close.newPositionCommitment]),
    ...[...store.liquidations.values()].map((liquidation) => liquidation.positionCommitment),
  ]);
  if ([...store.positionCommitments].some((commitment) => !indexed.has(commitment))) {
    metadata.missingPositionCount++;
    return incomplete("unindexed position commitments prevent complete market exposure");
  }
  const closed = new Set([
    ...[...store.positionCloses.values()].map((close) => positionKey(close)),
    ...[...store.liquidations.values()].map((liquidation) => positionKey(liquidation)),
  ]);
  const settlements = new Map<Hex, BatchSettlement>();
  for (const settlement of store.settlements.values()) {
    if (settlement.marketId !== marketId) continue;
    if (options.requireOnchainConfirmation && settlement.onchainConfirmed !== true) {
      if (settlement.onchainConfirmed === false) continue;
      return incomplete("historical settlement confirmation is unavailable");
    }
    const previous = settlements.get(settlement.settlementDigest);
    if (previous && (previous.aggregateVolume !== settlement.aggregateVolume ||
      previous.newCommitments.join() !== settlement.newCommitments.join())) {
      return incomplete("conflicting settlement exposure records");
    }
    settlements.set(settlement.settlementDigest, settlement);
  }

  const covered = new Set<Hex>();
  const unconfirmed = new Set([...store.settlements.values()]
    .filter((settlement) => settlement.marketId === marketId && settlement.onchainConfirmed === false)
    .flatMap((settlement) => settlement.newCommitments));
  let gross = 0n;
  for (const settlement of settlements.values()) {
    if (settlement.fillCount !== settlement.newCommitments.length ||
      settlement.newCommitments.length % 2 !== 0 || settlement.aggregateVolume < 0n ||
      settlement.aggregateVolume % 2n !== 0n) return incomplete("invalid settled exposure totals");
    const positions: PositionLifecycleRecord[] = [];
    for (const commitment of settlement.newCommitments) {
      if (covered.has(commitment)) return incomplete("position occurs in multiple settlement records");
      covered.add(commitment);
      metadata.positionCount++;
      const position = store.positionLifecycle.get(commitment);
      if (!position || position.marketId !== marketId || position.settlementDigest !== settlement.settlementDigest) {
        metadata.missingPositionCount++;
      } else positions.push(position);
    }
    if (positions.length !== settlement.newCommitments.length) return incomplete("settled position lifecycle is incomplete");
    try { assertSettlementExposure(settlement, positions, store.privateMatchIntents); }
    catch { return incomplete("settled position exposure is inconsistent"); }
    const active = positions.map((position) => isOpen(position, closed));
    if (active.every((value) => !value)) continue;
    if (active.every(Boolean)) { gross += settlement.aggregateVolume; continue; }

    let sizes: Array<bigint | undefined>;
    try { sizes = reconstructSizes(settlement, positions, store.privateMatchIntents); }
    catch { return incomplete("historical position quantities are inconsistent"); }
    const activeKnown = positions.every((_, index) => !active[index] || sizes[index] !== undefined);
    const inactiveKnown = positions.every((_, index) => active[index] || sizes[index] !== undefined);
    if (!activeKnown && !inactiveKnown) {
      metadata.missingPositionCount += positions.filter((_, index) => sizes[index] === undefined).length;
      return incomplete("historical position quantities are unavailable after a partial exit");
    }
    const activeGross = activeKnown
      ? sizes.reduce<bigint>((sum, size, index) => sum + (active[index] ? size! : 0n), 0n)
      : settlement.aggregateVolume - sizes.reduce<bigint>((sum, size, index) => sum + (!active[index] ? size! : 0n), 0n);
    if (activeGross < 0n || activeGross > settlement.aggregateVolume) return incomplete("invalid remaining position exposure");
    gross += activeGross;
  }
  for (const position of store.positionLifecycle.values()) {
    if (position.marketId !== marketId || covered.has(position.positionCommitment) ||
      (options.requireOnchainConfirmation && unconfirmed.has(position.positionCommitment)) || !isOpen(position, closed)) continue;
    metadata.positionCount++;
    metadata.missingPositionCount++;
  }
  if (metadata.missingPositionCount) return incomplete("open positions lack their settlement history");
  if (markPrice <= 0n) return incomplete("current mark price is unavailable");
  return { ...metadata, status: "available", grossBaseAmount: gross, baseAmount: gross / 2n,
    quoteAmount: (gross * markPrice) / (2n * PRICE_SCALE) };
}

/** Validate private accounting fields against public totals and retained bound order payloads. */
export function assertSettlementExposure(
  settlement: BatchSettlement,
  positions: PositionLifecycleRecord[],
  privateIntents: ReadonlyMap<Hex, PrivateMatchIntent>,
): void {
  if (!positions.some((position) => position.size !== undefined || position.side !== undefined)) return;
  if (positions.length !== settlement.newCommitments.length || positions.some((position) =>
    position.size === undefined || position.size <= 0n || (position.side !== "long" && position.side !== "short"))) {
    throw new Error("incomplete private position exposure");
  }
  if (positions.reduce((sum, position) => sum + position.size!, 0n) !== settlement.aggregateVolume) {
    throw new Error("position exposure aggregate mismatch");
  }
  const byCommitment = new Map(positions.map((position) => [position.positionCommitment, position]));
  for (let index = 0; index < settlement.newCommitments.length; index += 2) {
    const a = byCommitment.get(settlement.newCommitments[index]);
    const b = byCommitment.get(settlement.newCommitments[index + 1]);
    if (!a || !b || a.size !== b.size || a.side === b.side) throw new Error("position exposure pair mismatch");
  }
  for (const update of settlement.orderUpdates) {
    const source = privateIntents.get(update.intentCommitment);
    if (!source) continue;
    const opened = positions.filter((position) => position.sourceIntentCommitment === update.intentCommitment);
    if (opened.some((position) => position.side !== (source.signedSize > 0n ? "long" : "short"))) {
      throw new Error("position exposure direction mismatch");
    }
    const expected = filledSize(settlement, update.intentCommitment, privateIntents);
    if (expected !== undefined && opened.reduce((sum, position) => sum + position.size!, 0n) !== expected) {
      throw new Error("position exposure filled quantity mismatch");
    }
  }
}

function reconstructSizes(
  settlement: BatchSettlement,
  positions: PositionLifecycleRecord[],
  privateIntents: ReadonlyMap<Hex, PrivateMatchIntent>,
): Array<bigint | undefined> {
  const sizes = positions.map((position) => position.size);
  if (positions.length === 2) return sizes.map((size) => size ?? settlement.aggregateVolume / 2n);
  const groups = new Map<Hex, number[]>();
  positions.forEach((position, index) => {
    const indexes = groups.get(position.sourceIntentCommitment) ?? [];
    indexes.push(index); groups.set(position.sourceIntentCommitment, indexes);
  });
  for (let pass = 0; pass < positions.length; pass++) {
    let changed = false;
    for (const [source, indexes] of groups) {
      const total = filledSize(settlement, source, privateIntents);
      const unknown = indexes.filter((index) => sizes[index] === undefined);
      if (total !== undefined && unknown.length === 1) {
        const remaining = total - indexes.reduce((sum, index) => sum + (sizes[index] ?? 0n), 0n);
        if (remaining <= 0n) throw new Error("invalid reconstructed exposure");
        sizes[unknown[0]] = remaining; changed = true;
      }
    }
    for (let index = 0; index < positions.length; index += 2) {
      if (sizes[index] === undefined && sizes[index + 1] !== undefined) { sizes[index] = sizes[index + 1]; changed = true; }
      if (sizes[index + 1] === undefined && sizes[index] !== undefined) { sizes[index + 1] = sizes[index]; changed = true; }
    }
    if (!changed) break;
  }
  if (sizes.some((size) => size !== undefined && size <= 0n) ||
    (sizes.every((size) => size !== undefined) && sizes.reduce<bigint>((sum, size) => sum + size!, 0n) !== settlement.aggregateVolume)) {
    throw new Error("reconstructed exposure total mismatch");
  }
  for (let index = 0; index < sizes.length; index += 2) {
    if (sizes[index] !== undefined && sizes[index + 1] !== undefined && sizes[index] !== sizes[index + 1]) {
      throw new Error("reconstructed pair exposure mismatch");
    }
  }
  for (const [source, indexes] of groups) {
    const total = filledSize(settlement, source, privateIntents);
    if (total !== undefined && indexes.every((index) => sizes[index] !== undefined) &&
      indexes.reduce((sum, index) => sum + sizes[index]!, 0n) !== total) throw new Error("reconstructed source exposure mismatch");
  }
  return sizes;
}

function filledSize(settlement: BatchSettlement, sourceId: Hex, privateIntents: ReadonlyMap<Hex, PrivateMatchIntent>): bigint | undefined {
  const source = privateIntents.get(sourceId);
  const update = settlement.orderUpdates.find((item) => item.intentCommitment === sourceId);
  if (!source || !update || source.marketId !== settlement.marketId) return undefined;
  const size = abs(source.signedSize);
  if (update.status === "filled") return size;
  const residual = update.residualCommitment ? privateIntents.get(update.residualCommitment) : undefined;
  if (!residual || residual.marketId !== source.marketId || (residual.signedSize > 0n) !== (source.signedSize > 0n)) return undefined;
  const filled = size - abs(residual.signedSize);
  return filled > 0n ? filled : undefined;
}

function isOpen(position: PositionLifecycleRecord, closed: ReadonlySet<string>): boolean {
  return position.status === "open" && !closed.has(positionKey(position));
}

function positionKey(position: { marketId: string; positionCommitment: Hex; positionNullifier: Hex }): string {
  return `${position.marketId}:${position.positionCommitment}:${position.positionNullifier}`;
}

function abs(value: bigint): bigint { return value < 0n ? -value : value; }
