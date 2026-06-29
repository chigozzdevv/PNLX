import type {
  AssetDepositNoteInput,
  DepositNoteInput,
  FinalizeAssetDepositInput,
  ProvenAssetDepositNoteInput,
  ProvenWithdrawAssetNoteInput,
  ProvenWithdrawNoteInput,
  WithdrawAssetNoteInput,
  WithdrawNoteInput,
} from "./notes.model";
import { parseProofMeta } from "../intents/intents.schema";

export function parseDepositNote(input: Record<string, string>): DepositNoteInput {
  return {
    commitment: input.commitment as `0x${string}`,
  };
}

export function parseAssetDepositNote(input: Record<string, string>): AssetDepositNoteInput {
  const amount = BigInt(input.amount);
  if (amount <= 0n) throw new Error("asset deposit amount must be positive");
  return {
    amount,
    autoSign: parseOptionalBoolean(input.autoSign),
    blinding: optionalHex(input.blinding),
    commitment: input.commitment as `0x${string}`,
    from: required(input.from, "from"),
    ownerDigest: optionalHex(input.ownerDigest),
    rhoDigest: optionalHex(input.rhoDigest),
    source: input.source,
    token: required(input.token, "token"),
    tokenDigest: optionalHex(input.tokenDigest),
  };
}

export function parseProvenAssetDepositNote(input: Record<string, unknown>): ProvenAssetDepositNoteInput {
  const amount = BigInt(String(input.amount));
  if (amount <= 0n) throw new Error("asset deposit amount must be positive");
  return {
    amount,
    autoSign: parseOptionalBoolean(input.autoSign),
    commitment: required(input.commitment, "commitment") as `0x${string}`,
    depositProof: parseDepositNoteRecord(requiredObject(input.depositProof, "depositProof")),
    from: required(input.from, "from"),
    source: optionalString(input.source),
    token: required(input.token, "token"),
  };
}

export function parseFinalizeAssetDeposit(input: Record<string, unknown>): FinalizeAssetDepositInput {
  return {
    ...parseProvenAssetDepositNote(input),
    relayId: required(input.relayId, "relayId") as `0x${string}`,
  };
}

export function parseWithdrawNote(input: Record<string, unknown>): WithdrawNoteInput {
  return {
    assetDigest: required(input.assetDigest, "assetDigest") as `0x${string}`,
    blinding: required(input.blinding, "blinding") as `0x${string}`,
    changeBlinding: optionalHex(input.changeBlinding),
    changeRhoDigest: optionalHex(input.changeRhoDigest),
    noteAmount: BigInt(String(input.noteAmount)),
    noteCommitment: required(input.noteCommitment, "noteCommitment") as `0x${string}`,
    withdrawAmount: BigInt(String(input.withdrawAmount)),
    ownerDigest: required(input.ownerDigest, "ownerDigest") as `0x${string}`,
    pathIndices: parseBooleanArray(input.pathIndices, "pathIndices"),
    pathSiblings: parseHexArray(input.pathSiblings, "pathSiblings"),
    root: required(input.root, "root") as `0x${string}`,
    rhoDigest: required(input.rhoDigest, "rhoDigest") as `0x${string}`,
    nullifier: required(input.nullifier, "nullifier") as `0x${string}`,
    recipient: required(input.recipient, "recipient") as `0x${string}`,
    spendSecretDigest: required(input.spendSecretDigest, "spendSecretDigest") as `0x${string}`,
    tokenDigest: optionalHex(input.tokenDigest),
  };
}

export function parseWithdrawAssetNote(input: Record<string, unknown>): WithdrawAssetNoteInput {
  return {
    assetDigest: required(input.assetDigest, "assetDigest") as `0x${string}`,
    blinding: required(input.blinding, "blinding") as `0x${string}`,
    changeBlinding: optionalHex(input.changeBlinding),
    changeRhoDigest: optionalHex(input.changeRhoDigest),
    noteAmount: BigInt(String(input.noteAmount)),
    noteCommitment: required(input.noteCommitment, "noteCommitment") as `0x${string}`,
    withdrawAmount: BigInt(String(input.withdrawAmount)),
    ownerDigest: required(input.ownerDigest, "ownerDigest") as `0x${string}`,
    pathIndices: parseBooleanArray(input.pathIndices, "pathIndices"),
    pathSiblings: parseHexArray(input.pathSiblings, "pathSiblings"),
    root: required(input.root, "root") as `0x${string}`,
    rhoDigest: required(input.rhoDigest, "rhoDigest") as `0x${string}`,
    nullifier: required(input.nullifier, "nullifier") as `0x${string}`,
    recipient: required(input.recipientDigest, "recipientDigest") as `0x${string}`,
    recipientAddress: required(input.recipientAddress, "recipientAddress"),
    recipientDigest: required(input.recipientDigest, "recipientDigest") as `0x${string}`,
    spendSecretDigest: required(input.spendSecretDigest, "spendSecretDigest") as `0x${string}`,
    token: required(input.token, "token"),
    tokenDigest: required(input.tokenDigest, "tokenDigest") as `0x${string}`,
  };
}

export function parseProvenWithdrawNote(input: Record<string, unknown>): ProvenWithdrawNoteInput {
  return parseWithdrawalRecord(input);
}

export function parseProvenWithdrawAssetNote(input: Record<string, unknown>): ProvenWithdrawAssetNoteInput {
  return {
    ...parseWithdrawalRecord(input),
    recipientAddress: required(input.recipientAddress, "recipientAddress"),
    token: required(input.token, "token"),
  };
}

function parseDepositNoteRecord(input: Record<string, unknown>) {
  return {
    amount: BigInt(String(input.amount)),
    commitment: required(input.commitment, "commitment") as `0x${string}`,
    tokenDigest: required(input.tokenDigest, "tokenDigest") as `0x${string}`,
    proof: parseProofMeta(requiredObject(input.proof, "proof")),
  };
}

function parseWithdrawalRecord(input: Record<string, unknown>): ProvenWithdrawNoteInput {
  return {
    changeCommitment: required(input.changeCommitment, "changeCommitment") as `0x${string}`,
    nullifier: required(input.nullifier, "nullifier") as `0x${string}`,
    proof: parseProofMeta(requiredObject(input.proof, "proof")),
    recipient: required(input.recipient, "recipient") as `0x${string}`,
    root: required(input.root, "root") as `0x${string}`,
    tokenDigest: required(input.tokenDigest, "tokenDigest") as `0x${string}`,
    withdrawAmount: BigInt(String(input.withdrawAmount)),
  };
}

function required(value: unknown, field: string): string {
  if (!value) throw new Error(`${field} is required`);
  return String(value);
}

function parseOptionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  const raw = String(value);
  return raw === "1" || raw.toLowerCase() === "true" || raw.toLowerCase() === "yes";
}

function optionalString(value: unknown): string | undefined {
  return value === undefined || value === "" ? undefined : String(value);
}

function optionalHex(value: unknown): `0x${string}` | undefined {
  return value === undefined || value === "" ? undefined : (String(value) as `0x${string}`);
}

function parseHexArray(value: unknown, field: string): `0x${string}`[] {
  if (!Array.isArray(value)) throw new Error(`${field} is required`);
  return value.map((entry) => String(entry) as `0x${string}`);
}

function parseBooleanArray(value: unknown, field: string): boolean[] {
  if (!Array.isArray(value)) throw new Error(`${field} is required`);
  return value.map((entry) => entry === true || entry === "true" || entry === "1");
}

function requiredObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error(`${field} is required`);
  return value as Record<string, unknown>;
}
