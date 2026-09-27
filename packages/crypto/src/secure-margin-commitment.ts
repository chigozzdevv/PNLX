import type { Hex } from "@pnlx/protocol-types";
import { poseidon2Hash } from "@zkpassport/poseidon2";

const FIELD_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const MARGIN_DOMAIN = 0x504e4c5844524f504d4152n;
const NULLIFIER_DOMAIN = 0x504e4c5844524f504d4e554cn;

export interface SecureMarginNote {
  amount: bigint;
  assetDigest: Hex;
  blinding: Hex;
  ownerDigest: Hex;
  rhoDigest: Hex;
  spendSecretDigest: Hex;
}

function hashPair(left: Hex | bigint, right: Hex | bigint): Hex {
  return `0x${poseidon2Hash([BigInt(left) % FIELD_PRIME, BigInt(right) % FIELD_PRIME])
    .toString(16).padStart(64, "0")}`;
}

export function secureMarginCommitment(input: SecureMarginNote): Hex {
  if (input.amount < 0n || input.amount >= (1n << 128n) ||
    [input.assetDigest, input.blinding, input.ownerDigest, input.rhoDigest,
      input.spendSecretDigest].some((value) => BigInt(value) === 0n)) {
    throw new Error("Invalid secure margin note");
  }
  const opening = hashPair(input.assetDigest, input.amount);
  const ownership = hashPair(input.ownerDigest, hashPair(
    hashPair(input.rhoDigest, input.blinding), input.spendSecretDigest));
  return hashPair(MARGIN_DOMAIN, hashPair(opening, ownership));
}

export function secureMarginNullifier(input: Pick<SecureMarginNote, "rhoDigest" | "spendSecretDigest">): Hex {
  if (BigInt(input.rhoDigest) === 0n || BigInt(input.spendSecretDigest) === 0n) {
    throw new Error("Invalid secure margin secret");
  }
  return hashPair(NULLIFIER_DOMAIN, hashPair(input.spendSecretDigest, input.rhoDigest));
}
