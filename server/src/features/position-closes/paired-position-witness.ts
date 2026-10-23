import {
  circuitPositionCommitment, digestToFieldHex, fieldHex, hashFields, positionSecrets,
  secureMarginCommitment, secureMarginNullifier,
} from "@pnlx/crypto";
import { PRICE_SCALE } from "@pnlx/market-math";
import type { Hex, PositionCloseWitness, PositionLifecycleRecord } from "@pnlx/protocol-types";
import type { ProtocolStore } from "@/shared/state/store";
import type { StoredMakerNoteRecord } from "@/shared/maker-note-store";
import { reconstructPositionOpening } from "@/features/account-keys/account-key-recovery";

export function pairedPosition(store: ProtocolStore, position: PositionLifecycleRecord): PositionLifecycleRecord {
  const settlement = [...store.settlements.values()].find((item) => item.settlementDigest === position.settlementDigest);
  const index = settlement?.newCommitments.indexOf(position.positionCommitment) ?? -1;
  const paired = index < 0 ? undefined : store.positionLifecycle.get(settlement!.newCommitments[index ^ 1]!);
  if (!paired || paired.marketId !== position.marketId || paired.settlementDigest !== position.settlementDigest) {
    throw new Error("linked counterparty position is unavailable");
  }
  return paired;
}

export function positionPayout(store: ProtocolStore, position: PositionLifecycleRecord, mark: bigint, funding: bigint): bigint {
  const own = requiredOpening(store, position);
  const other = requiredOpening(store, pairedPosition(store, position));
  if (own.side === other.side || own.size !== other.size || own.entryPrice !== other.entryPrice || own.fundingIndex !== other.fundingIndex) {
    throw new Error("linked position economics mismatch");
  }
  const collateral = own.margin + other.margin;
  const pnl = own.size * (own.side === "long" ? mark - own.entryPrice : own.entryPrice - mark) / PRICE_SCALE;
  const payment = own.size * (funding - own.fundingIndex) / PRICE_SCALE * (own.side === "long" ? 1n : -1n);
  const equity = own.margin + pnl - payment;
  return equity < 0n ? 0n : equity > collateral ? collateral : equity;
}

export function hostedPositionCloseWitness(input: {
  store: ProtocolStore; position: PositionLifecycleRecord; markPrice: bigint;
  currentFundingIndex: bigint; assetDigest: Hex; closeCommitment: Hex;
}): { witness: PositionCloseWitness; note: StoredMakerNoteRecord } {
  const { store, position, markPrice, currentFundingIndex, assetDigest, closeCommitment } = input;
  const opening = requiredOpening(store, position);
  if (!opening.positionSeed || !opening.ownerDigest || opening.fillIndex === undefined) {
    throw new Error("position requires explicit legacy recovery migration");
  }
  const secrets = positionSecrets(opening.positionSeed, opening.fillIndex);
  const marketDigest = fieldHex(BigInt(hashFields("market-id", [position.marketId])));
  const payout = positionPayout(store, position, markPrice, currentFundingIndex);
  const privateSeed = `${secrets.spendSecretDigest}:${position.positionNullifier}:${closeCommitment}`;
  const derive = (label: string) => digestToFieldHex(`paired-close:${label}:${privateSeed}`);
  const newPositionRhoDigest = derive("position-rho");
  const newPositionBlinding = derive("position-blinding");
  const rhoDigest = derive("output-rho");
  const blinding = derive("output-blinding");
  const spendSecretDigest = derive("output-spend");
  const outputCommitment = secureMarginCommitment({amount: payout, assetDigest,
    ownerDigest: opening.ownerDigest, rhoDigest, blinding, spendSecretDigest});
  const membership = store.positionMembershipProof(position.positionCommitment);
  const witness: PositionCloseWitness = {
    marketId: position.marketId, positionCommitment: position.positionCommitment,
    positionNullifier: position.positionNullifier, positionRoot: membership.root,
    closeCommitment, side: opening.side, size: opening.size, closeSize: opening.size,
    entryPrice: opening.entryPrice, markPrice, margin: opening.margin,
    fundingIndex: opening.fundingIndex, currentFundingIndex,
    fundingPayment: opening.size * (currentFundingIndex - opening.fundingIndex) / PRICE_SCALE * (opening.side === "long" ? 1n : -1n),
    fee: 0n, newMargin: payout, remainingMargin: 0n, marginOutputAmount: payout,
    marketDigest, ownerDigest: opening.ownerDigest, ...secrets,
    newPositionRhoDigest, newPositionBlinding,
    newPositionCommitment: circuitPositionCommitment({marketDigest,ownerDigest:opening.ownerDigest,
      side:opening.side,size:0n,entryPrice:opening.entryPrice,margin:0n,fundingIndex:opening.fundingIndex,
      rhoDigest:newPositionRhoDigest,blinding:newPositionBlinding,spendSecretDigest:secrets.spendSecretDigest}),
    marginOutputCommitment:outputCommitment,marginOutputAssetDigest:assetDigest,
    marginOutputRhoDigest:rhoDigest,marginOutputBlinding:blinding,marginOutputSpendSecretDigest:spendSecretDigest,
    pathIndices:membership.indices,pathSiblings:membership.siblings,
  };
  return {witness,note:{amount:payout.toString(),assetDigest,blinding,commitment:outputCommitment,
    rhoDigest,spendSecretDigest,ownerDigest:opening.ownerDigest,ownerCommitment:position.ownerCommitment,
    noteNullifier:secureMarginNullifier({rhoDigest,spendSecretDigest}),noteFormat:"secure",
    closePositionCommitment:position.positionCommitment,closeCommitment,createdAt:Date.now()}};
}

function requiredOpening(store: ProtocolStore, position: PositionLifecycleRecord) {
  const opening = reconstructPositionOpening(store, position);
  if (!opening) throw new Error("position opening unavailable; explicit recovery migration is required");
  return opening;
}
