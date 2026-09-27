import { secureMarginCommitment, creditDropPositionCommitment, creditDropPositionNullifier, fieldHashPair,
  creditDropReturnCommitment, type CircuitPositionNoteInput, type FieldMerkleProof } from "@pnlx/crypto";
import { fundingPayment, splitCreditDropClose, unrealizedPnl } from "@pnlx/market-math";
import { contractPublicInputHash, publicField, publicU128 } from "@pnlx/proof-system";
import type { Hex } from "@pnlx/protocol-types";

export interface CreditDropCloseInput {
  position: CircuitPositionNoteInput & { sponsoredPrincipal: bigint; reserveDigest: Hex };
  membership: FieldMerkleProof;
  assetDigest: Hex;
  markPrice: bigint;
  currentFundingIndex: bigint;
  maintenanceRate: bigint;
  liquidation: boolean;
  outputRho: Hex;
  outputBlinding: Hex;
  outputSpendSecretDigest: Hex;
  reserveOutputRho: Hex;
}

export function prepareCreditDropClose(input: CreditDropCloseInput) {
  const { position } = input;
  if (position.size <= 0n || position.entryPrice <= 0n ||
    [position.size, position.entryPrice, position.margin, position.fundingIndex, input.markPrice,
      input.currentFundingIndex].some((value) => value < 0n || value >= (1n << 128n))) {
    throw new Error("Invalid sponsored position opening");
  }
  if ([input.assetDigest, position.ownerDigest, position.rhoDigest, position.blinding, position.marketDigest,
    position.spendSecretDigest].some((value) => BigInt(value) === 0n)) {
    throw new Error("Invalid sponsored close commitment fields");
  }
  const commitment = creditDropPositionCommitment(position);
  if (input.membership.leaf !== commitment || input.membership.siblings.length !== 20 || input.membership.indices.length !== 20) {
    throw new Error("Sponsored position membership mismatch");
  }
  const root = input.membership.siblings.reduce((node, sibling, index) =>
    input.membership.indices[index] ? fieldHashPair(sibling, node) : fieldHashPair(node, sibling), commitment);
  if (root !== input.membership.root) throw new Error("Sponsored position membership root mismatch");
  if (input.markPrice <= 0n || input.currentFundingIndex < 0n ||
    input.maintenanceRate <= 0n || input.maintenanceRate > 1_000_000n) {
    throw new Error("Invalid sponsored close market state");
  }
  const funding = fundingPayment(position.side === "long" ? position.size : -position.size,
    input.currentFundingIndex, position.fundingIndex);
  const equity = position.margin + unrealizedPnl(position.side, position.size, position.entryPrice, input.markPrice) - funding;
  const netEquity = equity < 0n ? 0n : equity;
  const maintenance = (position.size * input.markPrice / 100_000_000n) * input.maintenanceRate / 1_000_000n;
  if (input.liquidation ? netEquity >= maintenance : equity < 0n) {
    throw new Error(input.liquidation ? "Sponsored position is healthy" : "Sponsored position requires liquidation");
  }
  const split = splitCreditDropClose(netEquity, position.sponsoredPrincipal);
  const positionNullifier = creditDropPositionNullifier(position);
  if (split.traderAmount > 0n && (BigInt(input.outputRho) === 0n || BigInt(input.outputBlinding) === 0n ||
    BigInt(input.outputSpendSecretDigest) === 0n)) {
    throw new Error("Invalid trader output commitment fields");
  }
  if (split.reserveAmount > 0n && BigInt(input.reserveOutputRho) === 0n) {
    throw new Error("Invalid reserve output commitment fields");
  }
  const marginOutputCommitment = split.traderAmount === 0n ? "0x0" :
    secureMarginCommitment({ assetDigest: input.assetDigest, amount: split.traderAmount,
      ownerDigest: position.ownerDigest, rhoDigest: input.outputRho,
      blinding: input.outputBlinding, spendSecretDigest: input.outputSpendSecretDigest });
  const reserveOutputCommitment = split.reserveAmount === 0n ? "0x0" :
    creditDropReturnCommitment({ reserveDigest: position.reserveDigest,
      positionCommitment: commitment, amount: split.reserveAmount, rhoDigest: input.reserveOutputRho });
  const publicInputHash = contractPublicInputHash([
    publicField(position.marketDigest), publicField(input.assetDigest), publicField(position.reserveDigest),
    publicU128(input.markPrice), publicU128(input.currentFundingIndex), publicU128(input.maintenanceRate),
    publicU128(input.liquidation ? 1n : 0n), publicField(input.membership.root), publicField(commitment),
    publicField(positionNullifier), publicField(marginOutputCommitment), publicField(reserveOutputCommitment),
  ]);
  return {
    publicInputHash, positionCommitment: commitment, positionNullifier, marginOutputCommitment,
    reserveOutputCommitment, traderAmount: split.traderAmount, reserveAmount: split.reserveAmount,
    reserveLoss: split.reserveLoss,
    inputs: {
      market_digest: position.marketDigest, asset_digest: input.assetDigest,
      reserve_digest: position.reserveDigest, mark_price: input.markPrice,
      current_funding_index: input.currentFundingIndex, maintenance_rate: input.maintenanceRate,
      liquidation: input.liquidation, position_root: input.membership.root,
      position_commitment_public: commitment, position_nullifier: positionNullifier,
      margin_output_commitment: marginOutputCommitment, reserve_output_commitment: reserveOutputCommitment,
      is_long: position.side === "long", size: position.size, entry_price: position.entryPrice,
      margin: position.margin, funding_index: position.fundingIndex, owner_digest: position.ownerDigest,
      rho: position.rhoDigest, blinding: position.blinding, spend_secret_digest: position.spendSecretDigest,
      sponsored_principal: position.sponsoredPrincipal,
      margin_output_rho: input.outputRho, margin_output_blinding: input.outputBlinding,
      margin_output_spend_secret_digest: input.outputSpendSecretDigest,
      reserve_output_rho: input.reserveOutputRho, siblings: input.membership.siblings, indices: input.membership.indices,
    },
  };
}
