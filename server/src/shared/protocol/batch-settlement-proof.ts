import { hashFields } from "@merkl/crypto";
import { contractPublicInputHash, publicField, publicU128, type ContractPublicInput } from "@merkl/proof-system";
import type { BatchSettlement, Hex } from "@merkl/protocol-types";

const MAX_PUBLIC_ITEMS = 8;

export function batchSettlementPublicInputHash(settlement: BatchSettlement): Hex {
  return contractPublicInputHash([
    publicField(hashFields("batch-id", [settlement.batchId])),
    publicField(hashFields("market-id", [settlement.marketId])),
    publicField(settlement.oldRoot),
    publicField(settlement.newRoot),
    publicField(settlement.settlementDigest),
    ...publicVec(settlement.orderUpdates.map((update) => update.intentCommitment)),
    ...publicVec(settlement.newCommitments),
    ...publicVec(settlement.marginChangeCommitments),
    ...publicVec(settlement.spentNullifiers),
    publicU128(settlement.residualSize),
    publicU128(settlement.aggregateVolume),
  ]);
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
