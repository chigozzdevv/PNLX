import type {
  Hex,
  IntentRecord,
  IntentShares,
  IntentValidityRecord,
  IntentValidityWitness,
  ProofMeta,
  TradeIntent,
} from "@pnlx/protocol-types";
import type { CreateIntentInput, CreateSharedIntentInput, ProveAndSubmitIntentInput } from "@/features/intents/intents.model";
import type { NodeShareSet } from "@/workers/threshold-shares/threshold-shares.model";

type IntentBody = Record<string, unknown>;

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
  return {
    intent: parseTradeIntent(input),
    validity: parseIntentValidityRecord(requiredObject(input.validity, "validity")),
  };
}

export function parseSharedIntent(input: IntentBody): CreateSharedIntentInput {
  return {
    record: parseIntentRecord(requiredObject(input.record, "record")),
    shareSets: parseNodeShareSets(input.shareSets ?? input.shares),
    validity: parseIntentValidityRecord(requiredObject(input.validity, "validity")),
  };
}

export function parseIntentValidityWitness(input: IntentBody): IntentValidityWitness {
  return {
    assetDigest: String(input.assetDigest) as Hex,
    blinding: String(input.blinding) as Hex,
    currentBatch: BigInt(String(input.currentBatch)),
    expiryBatch: BigInt(String(input.expiryBatch)),
    intent: parseTradeIntent(input),
    marginRoot: String(input.marginRoot) as Hex,
    noteAmount: BigInt(String(input.noteAmount)),
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
    ownerCommitment: String(input.ownerCommitment) as Hex,
    ownerCommitmentField: String(input.ownerCommitmentField) as Hex,
    proof: parseProofMeta(requiredObject(input.proof, "proof")),
    shareCommitment: String(input.shareCommitment) as Hex,
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

function parseHexArray(value: unknown, field: string): Hex[] {
  if (!Array.isArray(value)) throw new Error(`${field} is required`);
  return value.map((entry) => String(entry) as Hex);
}

function parseBooleanArray(value: unknown, field: string): boolean[] {
  if (!Array.isArray(value)) throw new Error(`${field} is required`);
  return value.map((entry) => entry === true || entry === "true" || entry === "1");
}

function parseNodeShareSets(value: unknown): NodeShareSet[] {
  if (!Array.isArray(value)) throw new Error("shareSets is required");
  return value.map((entry) => {
    const set = requiredObject(entry, "shareSet");
    return {
      nodeId: String(set.nodeId),
      shares: parseIntentSharesArray(set.shares),
    };
  });
}

function parseIntentSharesArray(value: unknown): IntentShares[] {
  if (!Array.isArray(value)) throw new Error("shares is required");
  return value.map((entry) => {
    const share = requiredObject(entry, "share");
    return {
      intentCommitment: String(share.intentCommitment) as Hex,
      nodeId: String(share.nodeId),
      signedSize: parseFieldShare(requiredObject(share.signedSize, "signedSize")),
      limitPrice: parseFieldShare(requiredObject(share.limitPrice, "limitPrice")),
      margin: parseFieldShare(requiredObject(share.margin, "margin")),
    };
  });
}

function parseFieldShare(input: IntentBody) {
  return {
    x: BigInt(String(input.x)),
    y: BigInt(String(input.y)),
  };
}
