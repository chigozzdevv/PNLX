import { merklGet } from "@/lib/merkl-api";
import type { Hex, ServerProofMeta, Side } from "@/types/trading";

const FIELD_PRIME =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const LEFT_FACTOR = 131n;
const RIGHT_FACTOR = 137n;
const DOMAIN_FACTOR = 17n;

export interface SharedIntentTrade {
  batchId: string;
  limitPrice: bigint;
  margin: bigint;
  marketId: string;
  nonce: string;
  noteNullifier: Hex;
  owner: string;
  salt: string;
  side: Side;
  size: bigint;
}

export interface IntentValidityForSharedSubmit {
  batchDigest: Hex;
  currentBatch: bigint;
  expiryBatch: bigint;
  intentCommitment: Hex;
  marketDigest: Hex;
  marginRoot: Hex;
  noteCommitment: Hex;
  noteNullifier: Hex;
  ownerCommitmentField: Hex;
  proof: ServerProofMeta;
}

export interface SharedIntentMpcConfig {
  nodeIds: string[];
  threshold: number;
}

interface SharedIntentHealthResponse {
  matching: {
    mpc: SharedIntentMpcConfig;
  };
}

export interface SharedIntentSubmitPayload {
  record: {
    batchDigest: Hex;
    batchId: string;
    intentCommitment: Hex;
    marketDigest: Hex;
    marketId: string;
    marginRoot: Hex;
    noteNullifier: Hex;
    ownerCommitment: Hex;
    ownerCommitmentField: Hex;
    proof: ServerProofMeta;
    shareCommitment: Hex;
  };
  shareSets: Array<{
    nodeId: string;
    shares: Array<{
      intentCommitment: Hex;
      nodeId: string;
      signedSize: { x: string; y: string };
      limitPrice: { x: string; y: string };
      margin: { x: string; y: string };
    }>;
  }>;
  validity: {
    batchDigest: Hex;
    currentBatch: string;
    expiryBatch: string;
    intentCommitment: Hex;
    marketDigest: Hex;
    marginRoot: Hex;
    noteCommitment: Hex;
    noteNullifier: Hex;
    ownerCommitmentField: Hex;
    proof: ServerProofMeta;
  };
}

export async function buildSharedIntentPayload(input: {
  intent: SharedIntentTrade;
  mpc: SharedIntentMpcConfig;
  validity: IntentValidityForSharedSubmit;
}): Promise<SharedIntentSubmitPayload> {
  const binding = await intentBindingFields(input.intent);
  assertValidityMatches(input.validity, binding, input.intent.noteNullifier);
  const owner = await ownerCommitment(input.intent.owner);
  const shareSets = await shareIntent(input.intent, input.validity.intentCommitment, input.mpc);
  const shareCommitment = await shareCommitmentFor(
    input.validity.intentCommitment,
    shareSets,
    input.mpc.nodeIds,
  );

  return {
    record: {
      batchDigest: input.validity.batchDigest,
      batchId: input.intent.batchId,
      intentCommitment: input.validity.intentCommitment,
      marketDigest: input.validity.marketDigest,
      marketId: input.intent.marketId,
      marginRoot: input.validity.marginRoot,
      noteNullifier: input.validity.noteNullifier,
      ownerCommitment: owner,
      ownerCommitmentField: input.validity.ownerCommitmentField,
      proof: input.validity.proof,
      shareCommitment,
    },
    shareSets: shareSets.map((set) => ({
      nodeId: set.nodeId,
      shares: set.shares.map((share) => ({
        intentCommitment: share.intentCommitment,
        nodeId: share.nodeId,
        signedSize: stringifyShare(share.signedSize),
        limitPrice: stringifyShare(share.limitPrice),
        margin: stringifyShare(share.margin),
      })),
    })),
    validity: {
      batchDigest: input.validity.batchDigest,
      currentBatch: input.validity.currentBatch.toString(),
      expiryBatch: input.validity.expiryBatch.toString(),
      intentCommitment: input.validity.intentCommitment,
      marketDigest: input.validity.marketDigest,
      marginRoot: input.validity.marginRoot,
      noteCommitment: input.validity.noteCommitment,
      noteNullifier: input.validity.noteNullifier,
      ownerCommitmentField: input.validity.ownerCommitmentField,
      proof: input.validity.proof,
    },
  };
}

export async function getSharedIntentMpcConfig(token?: string): Promise<SharedIntentMpcConfig> {
  const health = await merklGet<SharedIntentHealthResponse>("/health", token);
  if (!health.matching.mpc.nodeIds.length) throw new Error("MPC nodes are not configured");
  return health.matching.mpc;
}

function assertValidityMatches(
  validity: IntentValidityForSharedSubmit,
  binding: Awaited<ReturnType<typeof intentBindingFields>>,
  noteNullifier: Hex,
): void {
  if (validity.intentCommitment !== binding.intentCommitment) {
    throw new Error("intent proof commitment mismatch");
  }
  if (validity.batchDigest !== binding.batchDigest) {
    throw new Error("intent proof batch mismatch");
  }
  if (validity.marketDigest !== binding.marketDigest) {
    throw new Error("intent proof market mismatch");
  }
  if (validity.ownerCommitmentField !== binding.ownerCommitmentField) {
    throw new Error("intent proof owner mismatch");
  }
  if (validity.noteNullifier !== noteNullifier) {
    throw new Error("intent proof nullifier mismatch");
  }
}

async function shareIntent(
  intent: SharedIntentTrade,
  intentCommitment: Hex,
  mpc: SharedIntentMpcConfig,
) {
  const signedSize = intent.side === "long" ? intent.size : -intent.size;
  return shareFields({
    intentCommitment,
    limitPrice: intent.limitPrice,
    margin: intent.margin,
    nodeIds: mpc.nodeIds,
    signedSize,
    threshold: mpc.threshold,
  });
}

async function shareFields(input: {
  intentCommitment: Hex;
  limitPrice: bigint;
  margin: bigint;
  nodeIds: string[];
  signedSize: bigint;
  threshold: number;
}) {
  const signedSizeShares = await splitSecret(
    encodeSigned(input.signedSize),
    input.threshold,
    input.nodeIds.length,
    `${input.intentCommitment}:signed-size`,
  );
  const limitPriceShares = await splitSecret(
    input.limitPrice,
    input.threshold,
    input.nodeIds.length,
    `${input.intentCommitment}:limit-price`,
  );
  const marginShares = await splitSecret(
    input.margin,
    input.threshold,
    input.nodeIds.length,
    `${input.intentCommitment}:margin`,
  );

  return input.nodeIds.map((nodeId, index) => ({
    nodeId,
    shares: [
      {
        intentCommitment: input.intentCommitment,
        nodeId,
        signedSize: signedSizeShares[index],
        limitPrice: limitPriceShares[index],
        margin: marginShares[index],
      },
    ],
  }));
}

async function shareCommitmentFor(
  intentCommitment: Hex,
  shareSets: Awaited<ReturnType<typeof shareFields>>,
  nodeIds: string[],
): Promise<Hex> {
  const ordered = nodeIds.map((nodeId) => {
    const set = shareSets.find((candidate) => candidate.nodeId === nodeId);
    if (!set) throw new Error("missing node share set");
    const share = set.shares[0];
    return [
      set.nodeId,
      share.signedSize.x,
      share.signedSize.y,
      share.limitPrice.x,
      share.limitPrice.y,
      share.margin.x,
      share.margin.y,
    ];
  });
  return hashFields("intent-shares", [intentCommitment, ordered]);
}

async function intentBindingFields(intent: SharedIntentTrade) {
  const owner = await ownerCommitment(intent.owner);
  const fields = {
    batchDigest: await digestToFieldHex(`batch:${intent.batchId}`),
    marketDigest: await digestToFieldHex(`market:${intent.marketId}`),
    ownerCommitmentField: fieldHex(BigInt(owner)),
    side: intent.side,
    size: intent.size,
    limitPrice: intent.limitPrice,
    margin: intent.margin,
    noteNullifier: intent.noteNullifier,
    nonceDigest: await digestToFieldHex(`nonce:${intent.nonce}`),
    saltDigest: await digestToFieldHex(`salt:${intent.salt}`),
  };
  return {
    ...fields,
    intentCommitment: circuitIntentCommitment(fields),
  };
}

function circuitIntentCommitment(input: {
  batchDigest: Hex;
  marketDigest: Hex;
  ownerCommitmentField: Hex;
  side: Side;
  size: bigint;
  limitPrice: bigint;
  margin: bigint;
  noteNullifier: Hex;
  nonceDigest: Hex;
  saltDigest: Hex;
}): Hex {
  const side = input.side === "long" ? 1n : 2n;
  const scope = fieldHashPair(
    fieldHashPair(input.batchDigest, input.marketDigest),
    fieldHashPair(input.ownerCommitmentField, side),
  );
  const economics = fieldHashPair(
    fieldHashPair(input.size, input.limitPrice),
    fieldHashPair(input.margin, input.noteNullifier),
  );
  const entropy = fieldHashPair(input.nonceDigest, input.saltDigest);
  return fieldHashPair(fieldHashPair(scope, economics), entropy);
}

async function splitSecret(
  secret: bigint,
  threshold: number,
  shareCount: number,
  salt: string,
): Promise<Array<{ x: bigint; y: bigint }>> {
  if (threshold < 2) throw new Error("threshold must be at least 2");
  if (shareCount < threshold) throw new Error("share count must satisfy threshold");

  const coefficients = [mod(secret)];
  for (let i = 1; i < threshold; i += 1) {
    coefficients.push(await hashToField(`${salt}:${i}`));
  }

  const shares: Array<{ x: bigint; y: bigint }> = [];
  for (let x = 1n; x <= BigInt(shareCount); x += 1n) {
    let y = 0n;
    for (let power = 0; power < coefficients.length; power += 1) {
      y = mod(y + coefficients[power] * x ** BigInt(power));
    }
    shares.push({ x, y });
  }
  return shares;
}

function stringifyShare(share: { x: bigint; y: bigint }): { x: string; y: string } {
  return {
    x: share.x.toString(),
    y: share.y.toString(),
  };
}

async function ownerCommitment(owner: string): Promise<Hex> {
  return hashFields("owner", [owner]);
}

async function hashFields(domain: string, fields: unknown[]): Promise<Hex> {
  return `0x${await sha256Hex(`merkl:${domain}:${fields.map(normalize).join("|")}`)}`;
}

function normalize(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return value;
  if (typeof value === "number") return value.toString();
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return `[${value.map(normalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries.map(([key, entry]) => `${key}:${normalize(entry)}`).join(",")}}`;
}

async function digestToFieldHex(input: string): Promise<Hex> {
  return fieldHex(await hashToField(input));
}

async function hashToField(input: string): Promise<bigint> {
  return BigInt(`0x${await sha256Hex(input)}`) % FIELD_PRIME;
}

function fieldHashPair(left: Hex | bigint, right: Hex | bigint): Hex {
  return fieldHex(
    toField(left) * LEFT_FACTOR +
      toField(right) * RIGHT_FACTOR +
      DOMAIN_FACTOR,
  );
}

function fieldHex(value: bigint): Hex {
  return `0x${mod(value).toString(16).padStart(64, "0")}`;
}

function toField(value: Hex | bigint): bigint {
  return typeof value === "bigint" ? mod(value) : mod(BigInt(value));
}

function mod(value: bigint): bigint {
  const out = value % FIELD_PRIME;
  return out >= 0n ? out : out + FIELD_PRIME;
}

function encodeSigned(value: bigint): bigint {
  return mod(value);
}

async function sha256Hex(input: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Browser crypto is unavailable");
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
