import { hashFields } from "@pnlx/crypto";
import { contractPublicInputHash, publicField, publicU128, type ContractPublicInput } from "@pnlx/proof-system";
import type { BatchSettlement, BatchSettlementCapacity, Hex } from "@pnlx/protocol-types";

const MAX_PUBLIC_ITEMS = 8;
const CAPACITY_MARKER = "; capacity=";
type SettlementOutputs = Pick<BatchSettlement, "orderUpdates" | "newCommitments" | "marginChangeCommitments" | "spentNullifiers"> &
  Partial<Pick<BatchSettlement, "makerIntents" | "takerIntents" | "matchingPayloadCommitments" | "residualCommitments" | "residualMargins" | "residualPayloadCommitments">>;

export function assertBatchSettlementCapacity(settlement: SettlementOutputs, matchedExecutions?: number): void {
  const capacity: BatchSettlementCapacity = {
    limit: MAX_PUBLIC_ITEMS,
    filledIntents: settlement.orderUpdates.length,
    positionOutputs: settlement.newCommitments.length,
    marginChangeOutputs: settlement.marginChangeCommitments.length,
    notesToSpend: settlement.spentNullifiers.length,
    ...(matchedExecutions === undefined ? {} : { matchedExecutions }),
  };
  if ([capacity.filledIntents, capacity.positionOutputs, capacity.marginChangeOutputs, capacity.notesToSpend, settlement.matchingPayloadCommitments?.length ?? 0, settlement.residualCommitments?.length ?? 0, settlement.residualMargins?.length ?? 0, settlement.residualPayloadCommitments?.length ?? 0, settlement.makerIntents?.length ?? 0, settlement.takerIntents?.length ?? 0]
    .some((count) => count > capacity.limit)) {
    throw new Error(`batch proof supports at most ${MAX_PUBLIC_ITEMS} public items${CAPACITY_MARKER}${JSON.stringify(capacity)}`);
  }
}

export function readBatchSettlementCapacity(reason?: string): BatchSettlementCapacity | undefined {
  const markerIndex = reason?.lastIndexOf(CAPACITY_MARKER) ?? -1;
  if (!reason || markerIndex < 0) return undefined;
  try {
    const value = JSON.parse(reason.slice(markerIndex + CAPACITY_MARKER.length)) as Record<string, unknown>;
    if (!value || typeof value !== "object") return undefined;
    const { limit, filledIntents, positionOutputs, marginChangeOutputs, notesToSpend, matchedExecutions } = value;
    if (![limit, filledIntents, positionOutputs, marginChangeOutputs, notesToSpend]
      .every((count) => typeof count === "number" && Number.isSafeInteger(count) && count >= 0)) return undefined;
    if ((limit as number) < 1) return undefined;
    if (matchedExecutions !== undefined &&
      !(typeof matchedExecutions === "number" && Number.isSafeInteger(matchedExecutions) && matchedExecutions >= 0)) return undefined;
    return { limit, filledIntents, positionOutputs, marginChangeOutputs, notesToSpend,
      ...(matchedExecutions === undefined ? {} : { matchedExecutions }),
    } as BatchSettlementCapacity;
  } catch {
    return undefined;
  }
}

export function batchSettlementPublicInputHash(settlement: BatchSettlement): Hex {
  assertBatchSettlementCapacity(settlement);
  if ([settlement.matchingPayloadCommitments, settlement.residualCommitments, settlement.residualMargins, settlement.residualPayloadCommitments]
    .some((items) => !items || items.length !== settlement.orderUpdates.length)) {
    throw new Error("intent payload count mismatch");
  }
  return contractPublicInputHash([
    publicField(hashFields("batch-id", [settlement.batchId])),
    publicField(hashFields("market-id", [settlement.marketId])),
    publicField(settlement.settlementDigest),
    ...publicVec(settlement.orderUpdates.map((update) => update.intentCommitment)),
    ...publicVec(settlement.newCommitments),
    ...publicVec(settlement.marginChangeCommitments),
    ...publicVec(settlement.spentNullifiers),
    ...publicVec(settlement.matchingPayloadCommitments),
    ...publicVec(settlement.residualCommitments),
    ...publicAmounts(settlement.residualMargins),
    ...publicVec(settlement.residualPayloadCommitments),
    publicU128(settlement.residualSize),
    publicU128(settlement.aggregateVolume),
    publicField(settlement.feeConfigHash),
    publicU128(settlement.grossTakerFee),
    publicU128(settlement.makerRebate),
    publicU128(settlement.insuranceFee),
    publicU128(settlement.treasuryFee),
    ...publicVec(settlement.makerIntents),
    ...publicVec(settlement.takerIntents),
  ]);
}

function publicAmounts(values: bigint[]): ContractPublicInput[] {
  if (values.length > MAX_PUBLIC_ITEMS) {
    throw new Error(`batch proof supports at most ${MAX_PUBLIC_ITEMS} public items`);
  }
  return [
    publicU128(BigInt(values.length)),
    ...values.map(publicU128),
    ...Array<ContractPublicInput>(MAX_PUBLIC_ITEMS - values.length).fill(publicU128(0n)),
  ];
}

function publicVec(values: Hex[]): ContractPublicInput[] {
  if (values.length > MAX_PUBLIC_ITEMS) {
    throw new Error(`batch proof supports at most ${MAX_PUBLIC_ITEMS} public items`);
  }

  return [
    publicU128(BigInt(values.length)),
    ...values.map((value) => publicField(value)),
    ...Array<ContractPublicInput>(MAX_PUBLIC_ITEMS - values.length).fill(publicField("0x0")),
  ];
}
