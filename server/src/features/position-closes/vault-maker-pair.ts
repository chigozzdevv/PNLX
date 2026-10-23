import {
  hashFields,
  ownerCommitment,
} from "@pnlx/crypto";
import type { Hex, PositionCloseWitness, PositionLifecycleRecord } from "@pnlx/protocol-types";
import { reconstructPositionOpening } from "@/features/account-keys/account-key-recovery";
import type { StoredMakerNoteRecord } from "@/shared/maker-note-store";
import type { ProtocolStore } from "@/shared/state/store";
import type { VaultMakerAllocation } from "@/shared/vault-maker-backing";
import { hostedPositionCloseWitness } from "./paired-position-witness";


export interface VaultMakerPair {
  allocation: VaultMakerAllocation;
  makerNote: StoredMakerNoteRecord;
  makerPosition: PositionLifecycleRecord;
  principal: bigint;
}

export function vaultMakerPairForTrader(input: {
  allocations: VaultMakerAllocation[];
  asset: string;
  maker: string;
  notes: StoredMakerNoteRecord[];
  store: ProtocolStore;
  trader: PositionLifecycleRecord;
  vault: string;
}): VaultMakerPair | undefined {
  const { store, trader } = input;
  const settlement = [...store.settlements.values()].find(
    (item) => item.settlementDigest === trader.settlementDigest,
  );
  const index = settlement?.newCommitments.indexOf(trader.positionCommitment) ?? -1;
  if (!settlement || index < 0 || settlement.newCommitments.length % 2 !== 0) return undefined;
  const paired = store.positionLifecycle.get(settlement.newCommitments[index ^ 1]!);
  if (!paired || paired.ownerCommitment !== ownerCommitment(input.maker)) return undefined;
  if (paired.batchId !== trader.batchId || paired.marketId !== trader.marketId ||
    paired.settlementDigest !== trader.settlementDigest) {
    throw new Error("vault maker position does not match the trader settlement");
  }
  const pairIndex = Math.floor(index / 2);
  const matchedIntents = [settlement.makerIntents[pairIndex], settlement.takerIntents[pairIndex]];
  if (!matchedIntents.includes(trader.sourceIntentCommitment) ||
    !matchedIntents.includes(paired.sourceIntentCommitment)) {
    throw new Error("vault maker intent does not match the trader fill");
  }
  if (paired.status !== "open") throw new Error("paired vault maker position is not open");
  const notes = input.notes.filter((note) =>
    note.walletAddress === input.maker && note.status === "spent" && !note.recoveredAmount &&
    note.lockedByIntentCommitment === paired.sourceIntentCommitment &&
    typeof note.vaultAllocationId === "string");
  if (notes.length !== 1) throw new Error("paired vault maker note is unavailable or ambiguous");
  const makerNote = notes[0]!;
  const allocations = input.allocations.filter((allocation) =>
    allocation.id === makerNote.vaultAllocationId && allocation.maker === input.maker &&
    allocation.vault === input.vault && allocation.asset === input.asset &&
    allocation.status !== "closed");
  if (allocations.length !== 1) throw new Error("paired vault allocation is unavailable");
  if (makerNote.token !== input.asset) throw new Error("paired vault maker asset does not match");
  const byCommitment = new Map(input.notes.map((note) => [note.commitment, note]));
  const visited = new Set<string>();
  let ancestor = makerNote;
  while (typeof ancestor.vaultParentCommitment === "string") {
    if (visited.has(String(ancestor.commitment))) throw new Error("vault maker note ancestry has a cycle");
    visited.add(String(ancestor.commitment));
    const parent = byCommitment.get(ancestor.vaultParentCommitment);
    if (!parent || parent.status !== "spent" || parent.walletAddress !== input.maker ||
      parent.token !== input.asset || parent.vaultAllocationId !== makerNote.vaultAllocationId ||
      BigInt(String(parent.amount)) < BigInt(String(ancestor.amount))) {
      throw new Error("paired vault maker note has invalid ancestry");
    }
    ancestor = parent;
  }
  if (!allocations[0]!.noteCommitments.includes(String(ancestor.commitment))) {
    throw new Error("paired vault maker note is not rooted in its allocation");
  }
  if (typeof makerNote.commitment !== "string" || typeof makerNote.assetDigest !== "string") {
    throw new Error("paired vault maker note is incomplete");
  }
  const opening = reconstructPositionOpening(store, paired);
  if (!opening) throw new Error("vault maker position opening cannot be reconstructed");
  const principal = opening.margin + (opening.entryFee ?? 0n);
  if (principal <= 0n || principal > BigInt(String(makerNote.amount))) {
    throw new Error("vault maker position principal exceeds its note");
  }
  return { allocation: allocations[0]!, makerNote, makerPosition: paired, principal };
}

export function preparePairedMakerClose(input: {
  fundingIndex: bigint;
  makerNote: StoredMakerNoteRecord;
  makerPosition: PositionLifecycleRecord;
  markPrice: bigint;
  store: ProtocolStore;
  traderCloseCommitment: Hex;
}): { witness: PositionCloseWitness; note: StoredMakerNoteRecord & { commitment: string } } {
  if (typeof input.makerNote.spendSecretDigest !== "string" ||
    !/^0x[0-9a-f]{64}$/i.test(input.makerNote.spendSecretDigest) ||
    BigInt(input.makerNote.spendSecretDigest) === 0n) {
    throw new Error("vault maker note spend secret is unavailable");
  }
  if(typeof input.makerNote.assetDigest!=="string")throw new Error("vault maker collateral asset is unavailable");
  const closeCommitment = hashFields("vault-maker-close", [
    input.makerPosition.positionCommitment, input.traderCloseCommitment,
  ]);
  const prepared=hostedPositionCloseWitness({store:input.store,position:input.makerPosition,
    currentFundingIndex:input.fundingIndex,markPrice:input.markPrice,
    assetDigest:input.makerNote.assetDigest as Hex,closeCommitment});
  return {witness:prepared.witness,note:{...prepared.note,
    commitment:prepared.witness.marginOutputCommitment,walletAddress:String(input.makerNote.walletAddress),
    token:input.makerNote.token,vaultAllocationId:input.makerNote.vaultAllocationId,
    vaultParentCommitment:input.makerNote.commitment,
  }};
}
