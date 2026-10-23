import type { Hex } from "@pnlx/protocol-types";
import { fieldHashPair, positionEntropyDigest } from "./field-merkle";

export function circuitMatchingPayloadCommitment(input: {
  intentCommitment: Hex;
  marketDigest: Hex;
  ownerDigest: Hex;
  signedSize: bigint;
  limitPrice: bigint;
  margin: bigint;
  noteNullifier: Hex;
  noteChangeCommitment: Hex;
  positionSeed: Hex;
}): Hex {
  const size = input.signedSize < 0n ? -input.signedSize : input.signedSize;
  if (size <= 0n || input.limitPrice <= 0n || input.margin <= 0n) throw new Error("invalid matching economics");
  let result = fieldHashPair(input.noteChangeCommitment, positionEntropyDigest(input.positionSeed));
  for (const value of [input.noteNullifier, input.margin, input.limitPrice, size,
    input.signedSize > 0n ? 1n : 2n, input.ownerDigest, input.marketDigest]) {
    result = fieldHashPair(value, result);
  }
  return fieldHashPair(input.intentCommitment, result);
}
