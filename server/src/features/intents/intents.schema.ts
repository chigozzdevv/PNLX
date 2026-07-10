import type {
  Hex,
  IntentRecord,
  IntentValidityRecord,
  IntentValidityWitness,
  ProofMeta,
  TradeIntent,
} from "@pnlx/protocol-types";
import type { CreateIntentInput, ProveAndSubmitIntentInput } from "@/features/intents/intents.model";

type IntentBody = Record<string, unknown>;
const ZERO_HEX = "0x0" as Hex;

export function parseTradeIntent(input: IntentBody): TradeIntent {
  return {
    batchId: String(input.batchId),
    marketId: String(input.marketId),
    owner: String(input.owner),
    side: input.side === "short" ? "short" : "long",
    size: BigInt(String(input.size)),
    limitPrice: BigInt(String(input.limitPrice)),
    margin: BigInt(String(input.margin)),
    noteNullifier: String(input.noteNullifier) as Hex,
    nonce: String(input.nonce),
    salt: String(input.salt),
  };
}

export function parseIntent(input: IntentBody): CreateIntentInput {
  const intentInput = isObject(input.intent) ? input.intent : input;
  return {
    intent: parseTradeIntent(intentInput),
    validity: parseIntentValidityRecord(requiredObject(input.validity, "validity")),
  };
}

export function parseIntentValidityWitness(input: IntentBody): IntentValidityWitness {
  return {
    assetDigest: String(input.assetDigest) as Hex,
    blinding: String(input.blinding) as Hex,
    changeBlinding: optionalHex(input.changeBlinding) ?? ZERO_HEX,
    changeRhoDigest: optionalHex(input.changeRhoDigest) ?? ZERO_HEX,
    currentBatch: BigInt(String(input.currentBatch)),
    expiryBatch: BigInt(String(input.expiryBatch)),
    intent: parseTradeIntent(input),
    marginRoot: String(input.marginRoot) as Hex,
    noteAmount: BigInt(String(input.noteAmount)),
    noteChangeCommitment: optionalHex(input.noteChangeCommitment) ?? ZERO_HEX,
    noteCommitment: String(input.noteCommitment) as Hex,
    ownerDigest: String(input.ownerDigest) as Hex,
    pathIndices: parseBooleanArray(input.pathIndices, "pathIndices"),
    pathSiblings: parseHexArray(input.pathSiblings, "pathSiblings"),
    rhoDigest: String(input.rhoDigest) as Hex,
    spendSecretDigest: String(input.spendSecretDigest) as Hex,
  };
}

export const parseProveAndSubmitIntent = parseIntentValidityWitness as (
  input: IntentBody,
) => ProveAndSubmitIntentInput;

export function parseIntentValidityRecord(input: IntentBody): IntentValidityRecord {
  return {
    batchDigest: String(input.batchDigest) as Hex,
    currentBatch: BigInt(String(input.currentBatch)),
    expiryBatch: BigInt(String(input.expiryBatch)),
    intentCommitment: String(input.intentCommitment) as Hex,
    marketDigest: String(input.marketDigest) as Hex,
    noteChangeCommitment: optionalHex(input.noteChangeCommitment) ?? ZERO_HEX,
    noteCommitment: String(input.noteCommitment) as Hex,
    marginRoot: String(input.marginRoot) as Hex,
    noteNullifier: String(input.noteNullifier) as Hex,
    ownerCommitmentField: String(input.ownerCommitmentField) as Hex,
    proof: parseProofMeta(requiredObject(input.proof, "proof")),
  };
}

export function parseIntentRecord(input: IntentBody): IntentRecord {
  return {
    batchDigest: String(input.batchDigest) as Hex,
    batchId: String(input.batchId),
    intentCommitment: String(input.intentCommitment) as Hex,
    marketDigest: String(input.marketDigest) as Hex,
    marketId: String(input.marketId),
    marginRoot: String(input.marginRoot) as Hex,
    noteNullifier: String(input.noteNullifier) as Hex,
    noteChangeCommitment: optionalHex(input.noteChangeCommitment) ?? ZERO_HEX,
    ownerCommitment: String(input.ownerCommitment) as Hex,
    ownerCommitmentField: String(input.ownerCommitmentField) as Hex,
    proof: parseProofMeta(requiredObject(input.proof, "proof")),
    matchingPayloadCommitment: String(input.matchingPayloadCommitment) as Hex,
  };
}

export function parseProofMeta(input: IntentBody): ProofMeta {
  return {
    circuitId: String(input.circuitId),
    circuitKey: String(input.circuitKey) as Hex,
    circuitHash: String(input.circuitHash) as Hex,
    verifierHash: String(input.verifierHash) as Hex,
    publicInputHash: String(input.publicInputHash) as Hex,
    proofDigest: String(input.proofDigest) as Hex,
    proofSystem: parseProofSystem(input.proofSystem),
    bytecodeHash: optionalHex(input.bytecodeHash),
    boundlessRequestId: optionalHex(input.boundlessRequestId),
    imageId: optionalHex(input.imageId),
    journalDigest: optionalHex(input.journalDigest),
    witnessHash: optionalHex(input.witnessHash),
    proofHash: optionalHex(input.proofHash),
    publicInputsHash: optionalHex(input.publicInputsHash),
    sealDigest: optionalHex(input.sealDigest),
    vkHash: optionalHex(input.vkHash),
  };
}

function parseProofSystem(value: unknown): ProofMeta["proofSystem"] {
  if (value === undefined) return undefined;
  if (value === "noir-ultrahonk" || value === "risc0-groth16") return value;
  throw new Error("invalid proof system");
}

function optionalHex(value: unknown): Hex | undefined {
  return value === undefined ? undefined : (String(value) as Hex);
}

function requiredObject(value: unknown, field: string): IntentBody {
  if (!value || typeof value !== "object") throw new Error(`${field} is required`);
  return value as IntentBody;
}

function isObject(value: unknown): value is IntentBody {
  return Boolean(value && typeof value === "object");
}

function parseHexArray(value: unknown, field: string): Hex[] {
  if (!Array.isArray(value)) throw new Error(`${field} is required`);
  return value.map((entry) => String(entry) as Hex);
}

function parseBooleanArray(value: unknown, field: string): boolean[] {
  if (!Array.isArray(value)) throw new Error(`${field} is required`);
  return value.map((entry) => entry === true || entry === "true" || entry === "1");
}
