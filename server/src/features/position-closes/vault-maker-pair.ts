import {
  circuitMarginCommitment,
  circuitNullifier,
  digestToFieldHex,
  hashFields,
  ownerCommitment,
} from "@pnlx/crypto";
import { PRICE_SCALE, settleClose } from "@pnlx/market-math";
import { createCircuitPositionNote } from "@pnlx/sdk";
import type { Hex, PositionCloseRecord, PositionLifecycleRecord } from "@pnlx/protocol-types";
import { reconstructPositionOpening } from "@/features/account-keys/account-key-recovery";
import type { StoredMakerNoteRecord } from "@/shared/maker-note-store";
import type { ProtocolStore } from "@/shared/state/store";
import type { VaultMakerAllocation } from "@/shared/vault-maker-backing";
import type { ProverService } from "@/workers/prover/prover.service";

const ZERO_HEX = "0x0" as Hex;

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
  prover: ProverService;
  store: ProtocolStore;
  traderCloseCommitment: Hex;
}): { close: PositionCloseRecord; note: StoredMakerNoteRecord & { commitment: string } } {
  const { makerPosition: position, store } = input;
  const opening = reconstructPositionOpening(store, position);
  if (!opening) throw new Error("vault maker position opening cannot be reconstructed");
  const settlement = [...store.settlements.values()].find(
    (item) => item.settlementDigest === position.settlementDigest,
  );
  const index = settlement?.newCommitments.indexOf(position.positionCommitment) ?? -1;
  if (!settlement || index < 0) throw new Error("vault maker position is missing from its settlement");
  const owner = position.ownerCommitment;
  const rho = `${position.sourceIntentCommitment}:position:${index}`;
  const original = createCircuitPositionNote({
    marketId: position.marketId, side: opening.side, size: opening.size,
    entryPrice: opening.entryPrice, margin: opening.margin,
    fundingIndex: opening.fundingIndex, owner,
    spendSecret: `${owner}:${rho}`, rho,
    blinding: `${position.sourceIntentCommitment}:blinding:${index}`,
  });
  if (original.commitment !== position.positionCommitment ||
    original.positionNullifier !== position.positionNullifier) {
    throw new Error("vault maker witness does not match the recorded position");
  }
  const membership = store.positionMembershipProof(position.positionCommitment);
  const positionRoot = store.positionMembershipRoot();
  if (membership.root !== positionRoot) throw new Error("vault maker position root is not current");
  const fundingPayment = opening.size * (input.fundingIndex - opening.fundingIndex) /
    PRICE_SCALE * (opening.side === "long" ? 1n : -1n);
  const settled = settleClose({ side: opening.side, closeSize: opening.size,
    entryPrice: opening.entryPrice, markPrice: input.markPrice,
    margin: opening.margin, fundingPayment, fee: 0n });
  if (settled.newMargin <= 0n) throw new Error("vault maker position requires liquidation");
  const newPosition = createCircuitPositionNote({
    marketId: position.marketId, side: opening.side, size: 0n,
    entryPrice: opening.entryPrice, margin: 0n,
    fundingIndex: opening.fundingIndex, owner,
    spendSecret: `${owner}:${position.positionNullifier}:closed-position-spend`,
    rho: `${position.positionNullifier}:closed-position-rho`,
    blinding: `${position.positionNullifier}:closed-position-blinding`,
  });
  const rhoDigest = digestToFieldHex(`vault-maker-close-rho:${position.positionNullifier}`);
  const blinding = digestToFieldHex(`vault-maker-close-blinding:${position.positionNullifier}`);
  const assetDigest = input.makerNote.assetDigest as Hex;
  const outputCommitment = circuitMarginCommitment({
    amount: settled.newMargin, assetDigest, blinding,
    ownerDigest: original.ownerDigest, rhoDigest, spendSecretDigest: ZERO_HEX,
  });
  const closeCommitment = hashFields("vault-maker-close", [
    position.positionCommitment, input.traderCloseCommitment,
  ]);
  const close = input.prover.provePositionClose({
    marketId: position.marketId, positionCommitment: position.positionCommitment,
    positionRoot, positionNullifier: position.positionNullifier, closeCommitment,
    side: opening.side, size: opening.size, closeSize: opening.size,
    entryPrice: opening.entryPrice, markPrice: input.markPrice,
    margin: opening.margin, fundingPayment, fee: 0n,
    newMargin: settled.newMargin, fundingIndex: opening.fundingIndex,
    remainingMargin: 0n, marginOutputAmount: settled.newMargin,
    newPositionCommitment: newPosition.commitment,
    marginOutputCommitment: outputCommitment,
    marketDigest: original.marketDigest, ownerDigest: original.ownerDigest,
    rhoDigest: original.rhoDigest, blinding: original.blinding,
    spendSecretDigest: original.spendSecretDigest,
    newPositionRhoDigest: newPosition.rhoDigest,
    newPositionBlinding: newPosition.blinding,
    marginOutputAssetDigest: assetDigest,
    marginOutputRhoDigest: rhoDigest, marginOutputBlinding: blinding,
    pathIndices: membership.indices, pathSiblings: membership.siblings,
  });
  return { close, note: {
    amount: settled.newMargin.toString(), assetDigest, blinding,
    commitment: outputCommitment, createdAt: Date.now(),
    noteNullifier: circuitNullifier({ rhoDigest, spendSecretDigest: ZERO_HEX }),
    ownerCommitment: owner, ownerDigest: original.ownerDigest, rhoDigest,
    spendSecretDigest: ZERO_HEX, walletAddress: String(input.makerNote.walletAddress),
    closePositionCommitment: position.positionCommitment, closeCommitment,
  } };
}
