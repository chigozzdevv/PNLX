import type { Hex } from "@merkl/protocol-types";
import { FIELD_PRIME, hashToField, mod } from "./field";

export const FIELD_MERKLE_DEPTH = 8;
const LEFT_FACTOR = 131n;
const RIGHT_FACTOR = 137n;
const DOMAIN_FACTOR = 17n;

export interface CircuitMarginNoteInput {
  amount: bigint;
  assetDigest: Hex;
  blinding: Hex;
  ownerDigest: Hex;
  rhoDigest: Hex;
  spendSecretDigest: Hex;
}

export interface CircuitPositionNoteInput {
  blinding: Hex;
  entryPrice: bigint;
  fundingIndex: bigint;
  margin: bigint;
  marketDigest: Hex;
  ownerDigest: Hex;
  rhoDigest: Hex;
  side: "long" | "short";
  size: bigint;
  spendSecretDigest: Hex;
}

export interface CircuitDisclosureInput {
  claimDigest: Hex;
  saltDigest: Hex;
  subject: Hex;
  value: bigint;
}

export interface FieldMerkleProof {
  leaf: Hex;
  root: Hex;
  siblings: Hex[];
  indices: boolean[];
}

export function fieldHex(value: bigint): Hex {
  return `0x${mod(value).toString(16).padStart(64, "0")}`;
}

export function digestToFieldHex(input: string): Hex {
  return fieldHex(hashToField(input));
}

export function fieldHashPair(left: Hex | bigint, right: Hex | bigint): Hex {
  return fieldHex(
    toField(left) * LEFT_FACTOR +
      toField(right) * RIGHT_FACTOR +
      DOMAIN_FACTOR,
  );
}

export function circuitMarginCommitment(input: CircuitMarginNoteInput): Hex {
  const amount = fieldHex(input.amount);
  const left = fieldHashPair(input.assetDigest, amount);
  const right = fieldHashPair(
    input.ownerDigest,
    fieldHashPair(input.rhoDigest, input.blinding),
  );
  return fieldHashPair(left, right);
}

export function circuitNullifier(input: Pick<CircuitMarginNoteInput, "rhoDigest" | "spendSecretDigest">): Hex {
  return fieldHashPair(input.spendSecretDigest, input.rhoDigest);
}

export function circuitPositionCommitment(input: CircuitPositionNoteInput): Hex {
  const side = input.side === "long" ? 1n : 2n;
  const left = fieldHashPair(
    fieldHashPair(input.marketDigest, side),
    fieldHashPair(input.size, input.entryPrice),
  );
  const right = fieldHashPair(
    fieldHashPair(input.margin, input.fundingIndex),
    fieldHashPair(input.ownerDigest, fieldHashPair(input.rhoDigest, input.blinding)),
  );
  return fieldHashPair(left, right);
}

export function circuitPositionNullifier(
  input: Pick<CircuitPositionNoteInput, "rhoDigest" | "spendSecretDigest">,
): Hex {
  return fieldHashPair(input.spendSecretDigest, input.rhoDigest);
}

export function circuitDisclosureCommitment(input: CircuitDisclosureInput): Hex {
  return fieldHashPair(
    fieldHashPair(input.subject, input.claimDigest),
    fieldHashPair(input.value, input.saltDigest),
  );
}

export function fieldMerkleRoot(leaves: Hex[], depth = FIELD_MERKLE_DEPTH): Hex {
  return buildFieldMerkleLevels(leaves, depth).at(-1)![0];
}

export function fieldMerkleProof(
  leaves: Hex[],
  leaf: Hex,
  depth = FIELD_MERKLE_DEPTH,
): FieldMerkleProof {
  const normalizedLeaf = fieldHex(toField(leaf));
  const levels = buildFieldMerkleLevels(leaves, depth);
  let index = levels[0].findIndex((candidate) => candidate === normalizedLeaf);
  if (index < 0) throw new Error("leaf not found");

  const siblings: Hex[] = [];
  const indices: boolean[] = [];
  for (let level = 0; level < depth; level += 1) {
    const siblingIndex = index ^ 1;
    siblings.push(levels[level][siblingIndex] ?? emptyLeaf());
    indices.push(index % 2 === 1);
    index = Math.floor(index / 2);
  }

  return {
    leaf: normalizedLeaf,
    root: levels[depth][0],
    siblings,
    indices,
  };
}

function buildFieldMerkleLevels(leaves: Hex[], depth: number): Hex[][] {
  const width = 2 ** depth;
  const base = leaves.map((leaf) => fieldHex(toField(leaf))).sort();
  if (base.length > width) throw new Error("field merkle tree is full");
  while (base.length < width) base.push(emptyLeaf());

  const levels = [base];
  for (let level = 0; level < depth; level += 1) {
    const current = levels[level];
    const next: Hex[] = [];
    for (let i = 0; i < current.length; i += 2) {
      next.push(fieldHashPair(current[i], current[i + 1]));
    }
    levels.push(next);
  }
  return levels;
}

function emptyLeaf(): Hex {
  return fieldHex(0n);
}

function toField(value: Hex | bigint): bigint {
  return typeof value === "bigint" ? mod(value) : mod(BigInt(value));
}
