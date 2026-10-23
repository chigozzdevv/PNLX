import type { Hex } from "@pnlx/protocol-types";
import { fieldHashPair, positionMerkleProof,
  positionMerkleRoot, type CircuitPositionNoteInput, type FieldMerkleProof } from "./field-merkle";

const DROP_POSITION = 0x504e4c5844524f50504f53n;
const DROP_RETURN = 0x504e4c5844524f50524554n;
const DROP_NULLIFIER = 0x504e4c5844524f504e554cn;
const DROP_GRANT = 0x504e4c5844524f5047524en;
const DROP_GRANT_NULLIFIER = 0x504e4c5844524f50474e55n;

export interface CreditDropGrantOpening {
  epochId: Hex;
  ownerCommitment: Hex;
  amount: bigint;
  nonce: Hex;
}

export function creditDropGrantCommitment(input: CreditDropGrantOpening): Hex {
  assertGrantOpening(input);
  return fieldHashPair(DROP_GRANT, fieldHashPair(input.epochId,
    fieldHashPair(input.ownerCommitment, fieldHashPair(input.amount, input.nonce))));
}

export function creditDropGrantNullifier(input: Pick<CreditDropGrantOpening,
  "epochId" | "ownerCommitment" | "nonce">): Hex {
  if ([input.epochId, input.ownerCommitment, input.nonce].some((value) => BigInt(value) === 0n)) {
    throw new Error("Invalid Credit Drop grant nullifier");
  }
  return fieldHashPair(DROP_GRANT_NULLIFIER, fieldHashPair(input.epochId,
    fieldHashPair(input.ownerCommitment, input.nonce)));
}

export function creditDropGrantRoot(grants: CreditDropGrantOpening[]): Hex {
  return creditDropGrantEpoch(grants).root;
}

export function creditDropGrantBudget(grants: CreditDropGrantOpening[]): bigint {
  return creditDropGrantEpoch(grants).amount;
}

export function creditDropGrantEpoch(grants: CreditDropGrantOpening[]): { root: Hex; amount: bigint } {
  const leaves = sortedGrantLeaves(grants);
  const amount = grants.reduce((sum, grant) => sum + grant.amount, 0n);
  if (amount >= (1n << 127n)) throw new Error("Credit Drop epoch exceeds contract amount limit");
  return { root: positionMerkleRoot(leaves), amount };
}

export function creditDropGrantProof(grants: CreditDropGrantOpening[],
  grant: CreditDropGrantOpening): FieldMerkleProof {
  const leaves = sortedGrantLeaves(grants);
  const leaf = creditDropGrantCommitment(grant);
  return positionMerkleProof(leaves, leaf);
}

function sortedGrantLeaves(grants: CreditDropGrantOpening[]): Hex[] {
  if (grants.length === 0) throw new Error("Credit Drop epoch has no grants");
  const epochId = grants[0].epochId.toLowerCase();
  const owners = new Set<string>();
  return [...grants].sort((a, b) =>
    a.ownerCommitment.toLowerCase().localeCompare(b.ownerCommitment.toLowerCase())).map((grant) => {
    if (grant.epochId.toLowerCase() !== epochId) {
      throw new Error("Credit Drop grants must share one epoch");
    }
    const owner = grant.ownerCommitment.toLowerCase();
    if (owners.has(owner)) throw new Error("Duplicate Credit Drop owner in epoch");
    owners.add(owner);
    return creditDropGrantCommitment(grant);
  });
}

function assertGrantOpening(input: CreditDropGrantOpening): void {
  if (input.amount <= 0n || input.amount >= (1n << 128n) ||
    [input.epochId, input.ownerCommitment, input.nonce].some((value) => BigInt(value) === 0n)) {
    throw new Error("Invalid Credit Drop grant");
  }
}

export function creditDropPositionCommitment(input: CircuitPositionNoteInput & {
  sponsoredPrincipal: bigint;
  reserveDigest: Hex;
}): Hex {
  if (input.sponsoredPrincipal <= 0n || input.sponsoredPrincipal >= (1n << 128n) ||
    BigInt(input.reserveDigest) === 0n || BigInt(input.spendSecretDigest) === 0n) {
    throw new Error("Invalid sponsored position principal");
  }
  // Sponsored closes have a separate circuit format that already binds the spending secret.
  const side = input.side === "long" ? 1n : 2n;
  const base = fieldHashPair(
    fieldHashPair(fieldHashPair(input.marketDigest, side), fieldHashPair(input.size, input.entryPrice)),
    fieldHashPair(fieldHashPair(input.margin, input.fundingIndex),
      fieldHashPair(input.ownerDigest, fieldHashPair(input.rhoDigest, input.blinding))),
  );
  return fieldHashPair(DROP_POSITION, fieldHashPair(base,
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
