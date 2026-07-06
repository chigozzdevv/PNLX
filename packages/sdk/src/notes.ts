import type { Hex, MarginNote, PositionNote, Side, TradeIntent } from "@pnlx/protocol-types";
import {
  circuitMarginCommitment,
  circuitNullifier,
  circuitPositionCommitment,
  circuitPositionNullifier,
  commitMargin,
  commitPosition,
  digestToFieldHex,
  nullifier,
} from "@pnlx/crypto";

export function createMarginNote(input: {
  assetId: string;
  amount: bigint;
  owner: string;
  spendSecret: string;
  rho: string;
  blinding: string;
}): MarginNote & { commitment: string; nullifier: string } {
  const note: MarginNote = {
    assetId: input.assetId,
    amount: input.amount,
    owner: input.owner,
    rho: input.rho,
    blinding: input.blinding,
  };
  return {
    ...note,
    commitment: commitMargin(note),
    nullifier: nullifier(input.spendSecret, input.rho),
  };
}

export function createCircuitMarginNote(input: {
  assetDigest?: Hex;
  assetId: string;
  amount: bigint;
  owner: string;
  ownerDigest?: Hex;
  spendSecret: string;
  rho: string;
  blinding: string;
}) {
  const assetDigest = input.assetDigest ?? digestToFieldHex(`asset:${input.assetId}`);
  const ownerDigest = input.ownerDigest ?? digestToFieldHex(`owner:${input.owner}`);
  const rhoDigest = digestToFieldHex(`rho:${input.rho}`);
  const blinding = digestToFieldHex(`blinding:${input.blinding}`);
  const spendSecretDigest = digestToFieldHex(`spend:${input.spendSecret}`);
  const commitment = circuitMarginCommitment({
    amount: input.amount,
    assetDigest,
    blinding,
    ownerDigest,
    rhoDigest,
    spendSecretDigest,
  });
  const noteNullifier = circuitNullifier({ rhoDigest, spendSecretDigest });

  return {
    amount: input.amount,
    assetDigest,
    blinding,
    commitment,
    noteNullifier,
    ownerDigest,
    rhoDigest,
    spendSecretDigest,
  };
}

export function createPositionNote(input: {
  marketId: string;
  side: Side;
  size: bigint;
  entryPrice: bigint;
  margin: bigint;
  fundingIndex: bigint;
  owner: string;
  rho: string;
  blinding: string;
}): PositionNote & { commitment: string } {
  const note: PositionNote = { ...input };
  return { ...note, commitment: commitPosition(note) };
}

export function createCircuitPositionNote(input: {
  marketId: string;
  side: Side;
  size: bigint;
  entryPrice: bigint;
  margin: bigint;
  fundingIndex: bigint;
  owner: string;
  spendSecret: string;
  rho: string;
  blinding: string;
}) {
  const marketDigest = digestToFieldHex(`market:${input.marketId}`);
  const ownerDigest = digestToFieldHex(`owner:${input.owner}`);
  const rhoDigest = digestToFieldHex(`rho:${input.rho}`);
  const blinding = digestToFieldHex(`blinding:${input.blinding}`);
  const spendSecretDigest = digestToFieldHex(`spend:${input.spendSecret}`);
  const commitment = circuitPositionCommitment({
    blinding,
    entryPrice: input.entryPrice,
    fundingIndex: input.fundingIndex,
    margin: input.margin,
    marketDigest,
    ownerDigest,
    rhoDigest,
    side: input.side,
    size: input.size,
    spendSecretDigest,
  });
  const positionNullifier = circuitPositionNullifier({ rhoDigest, spendSecretDigest });

  return {
    blinding,
    commitment,
    entryPrice: input.entryPrice,
    fundingIndex: input.fundingIndex,
    margin: input.margin,
    marketDigest,
    ownerDigest,
    positionNullifier,
    rhoDigest,
    side: input.side,
    size: input.size,
    spendSecretDigest,
  };
}

export function createIntent(input: TradeIntent): TradeIntent {
  if (input.size <= 0n) throw new Error("intent size must be positive");
  if (input.margin <= 0n) throw new Error("intent margin must be positive");
  if (input.limitPrice <= 0n) throw new Error("intent limit price must be positive");
  return input;
}
