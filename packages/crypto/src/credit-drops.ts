import type { Hex } from "@pnlx/protocol-types";
import { circuitPositionCommitment, fieldHashPair,
  type CircuitPositionNoteInput } from "./field-merkle";

const DROP_POSITION = 0x504e4c5844524f50504f53n;
const DROP_RETURN = 0x504e4c5844524f50524554n;
const DROP_NULLIFIER = 0x504e4c5844524f504e554cn;

export function creditDropPositionCommitment(input: CircuitPositionNoteInput & {
  sponsoredPrincipal: bigint;
  reserveDigest: Hex;
}): Hex {
  if (input.sponsoredPrincipal <= 0n || input.sponsoredPrincipal >= (1n << 128n) ||
    BigInt(input.reserveDigest) === 0n || BigInt(input.spendSecretDigest) === 0n) {
    throw new Error("Invalid sponsored position principal");
  }
  return fieldHashPair(DROP_POSITION, fieldHashPair(circuitPositionCommitment(input),
    fieldHashPair(input.sponsoredPrincipal, fieldHashPair(input.reserveDigest, input.spendSecretDigest))));
}

export function creditDropPositionNullifier(input: Pick<CircuitPositionNoteInput, "rhoDigest" | "spendSecretDigest">): Hex {
  if (BigInt(input.rhoDigest) === 0n || BigInt(input.spendSecretDigest) === 0n) {
    throw new Error("Invalid sponsored position secret");
  }
  return fieldHashPair(DROP_NULLIFIER, fieldHashPair(input.spendSecretDigest, input.rhoDigest));
}

export function creditDropReturnCommitment(input: {
  reserveDigest: Hex;
  positionCommitment: Hex;
  amount: bigint;
  rhoDigest: Hex;
}): Hex {
  if (input.amount < 0n || input.amount >= (1n << 128n) || BigInt(input.rhoDigest) === 0n) {
    throw new Error("Invalid Credit Drop return");
  }
  return fieldHashPair(DROP_RETURN, fieldHashPair(input.reserveDigest,
    fieldHashPair(input.amount, fieldHashPair(input.positionCommitment, input.rhoDigest))));
}
