import type { Hex } from "@/types/trading";

const FIELD_PRIME =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const LEFT_FACTOR = 131n;
const RIGHT_FACTOR = 137n;
const DOMAIN_FACTOR = 17n;

export interface CircuitMarginNote {
  amount: bigint;
  assetDigest: Hex;
  blinding: Hex;
  commitment: Hex;
  noteNullifier: Hex;
  ownerDigest: Hex;
  rhoDigest: Hex;
  spendSecretDigest: Hex;
}

export interface CircuitMarginCommitmentInput {
  amount: bigint;
  assetDigest: Hex;
  blinding: Hex;
  ownerDigest: Hex;
  rhoDigest: Hex;
  spendSecretDigest: Hex;
}

export interface CircuitPositionCommitmentInput {
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

export async function createCircuitMarginNote(input: {
  amount: bigint;
  assetDigest?: Hex;
  assetId?: string;
  blinding: string;
  owner: string;
  ownerDigest?: Hex;
  rho: string;
  spendSecret: string;
}): Promise<CircuitMarginNote> {
  const assetDigest = input.assetDigest ?? (await digestToFieldHex(`asset:${input.assetId ?? "usdc"}`));
  const ownerDigest = input.ownerDigest ?? (await digestToFieldHex(`owner:${input.owner}`));
  const rhoDigest = await digestToFieldHex(`rho:${input.rho}`);
  const blinding = await digestToFieldHex(`blinding:${input.blinding}`);
  const spendSecretDigest = await digestToFieldHex(`spend:${input.spendSecret}`);
  const commitment = circuitMarginCommitment({
    amount: input.amount,
    assetDigest,
    blinding,
    ownerDigest,
    rhoDigest,
    spendSecretDigest,
  });
  const noteNullifier = fieldHashPair(spendSecretDigest, rhoDigest);

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

export function randomLabel(prefix: string): string {
  return `${prefix}-${Date.now()}-${randomHex(12)}`;
}

function circuitMarginCommitment(input: {
  amount: bigint;
  assetDigest: Hex;
  blinding: Hex;
  ownerDigest: Hex;
  rhoDigest: Hex;
  spendSecretDigest: Hex;
}): Hex {
  const amount = fieldHex(input.amount);
  const left = fieldHashPair(input.assetDigest, amount);
  const right = fieldHashPair(
    input.ownerDigest,
    fieldHashPair(input.rhoDigest, input.blinding),
  );
  return fieldHashPair(left, right);
}

export function createCircuitMarginCommitment(input: CircuitMarginCommitmentInput): Hex {
  return circuitMarginCommitment(input);
}

export function circuitPositionCommitment(input: CircuitPositionCommitmentInput): Hex {
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
  input: Pick<CircuitPositionCommitmentInput, "rhoDigest" | "spendSecretDigest">,
): Hex {
  return fieldHashPair(input.spendSecretDigest, input.rhoDigest);
}

export async function digestToFieldHex(input: string): Promise<Hex> {
  return fieldHex(BigInt(`0x${await sha256Hex(input)}`));
}

export function fieldHashPair(left: Hex | bigint, right: Hex | bigint): Hex {
  return fieldHex(
    toField(left) * LEFT_FACTOR +
      toField(right) * RIGHT_FACTOR +
      DOMAIN_FACTOR,
  );
}

export function fieldHex(value: bigint): Hex {
  return `0x${mod(value).toString(16).padStart(64, "0")}`;
}

function toField(value: Hex | bigint): bigint {
  return typeof value === "bigint" ? mod(value) : mod(BigInt(value));
}

function mod(value: bigint): bigint {
  const out = value % FIELD_PRIME;
  return out >= 0n ? out : out + FIELD_PRIME;
}

async function sha256Hex(input: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Browser crypto is unavailable");
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomHex(bytes: number): string {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Browser crypto is unavailable");
  }
  const value = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(value);
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
