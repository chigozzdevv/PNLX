import type {
  PositionCloseContextInput,
  CreatePositionCloseInput,
  CreateProvenPositionCloseInput,
} from "@/features/position-closes/position-closes.model";
import { parseProofMeta } from "@/features/intents/intents.schema";

type PositionCloseBody = Record<string, unknown>;

export function parsePositionCloseContext(request: Request): PositionCloseContextInput {
  const params = new URL(request.url).searchParams;
  return {
    ownerCommitment: String(params.get("ownerCommitment") ?? "") as `0x${string}`,
    positionCommitment: String(params.get("positionCommitment") ?? "") as `0x${string}`,
  };
}

export function parsePositionClose(input: PositionCloseBody): CreatePositionCloseInput {
  return {
    marketId: String(input.marketId),
    positionCommitment: String(input.positionCommitment) as `0x${string}`,
    positionNullifier: String(input.positionNullifier) as `0x${string}`,
    positionRoot: String(input.positionRoot) as `0x${string}`,
    closeCommitment: String(input.closeCommitment) as `0x${string}`,
    side: input.side === "short" ? "short" : "long",
    size: BigInt(String(input.size)),
    closeSize: BigInt(String(input.closeSize)),
    entryPrice: BigInt(String(input.entryPrice)),
    markPrice: BigInt(String(input.markPrice)),
    margin: BigInt(String(input.margin)),
    fundingIndex: BigInt(String(input.fundingIndex)),
    fundingPayment: BigInt(String(input.fundingPayment)),
    fee: BigInt(String(input.fee)),
    newMargin: BigInt(String(input.newMargin)),
    remainingMargin: BigInt(String(input.remainingMargin)),
    marginOutputAmount: BigInt(String(input.marginOutputAmount)),
    newPositionCommitment: String(input.newPositionCommitment) as `0x${string}`,
    marginOutputCommitment: String(input.marginOutputCommitment) as `0x${string}`,
    marketDigest: String(input.marketDigest) as `0x${string}`,
    ownerDigest: String(input.ownerDigest) as `0x${string}`,
    rhoDigest: String(input.rhoDigest) as `0x${string}`,
    blinding: String(input.blinding) as `0x${string}`,
    spendSecretDigest: String(input.spendSecretDigest) as `0x${string}`,
    newPositionRhoDigest: String(input.newPositionRhoDigest) as `0x${string}`,
    newPositionBlinding: String(input.newPositionBlinding) as `0x${string}`,
    marginOutputAssetDigest: String(input.marginOutputAssetDigest) as `0x${string}`,
    marginOutputRhoDigest: String(input.marginOutputRhoDigest) as `0x${string}`,
    marginOutputBlinding: String(input.marginOutputBlinding) as `0x${string}`,
    pathIndices: parseBooleanArray(input.pathIndices),
    pathSiblings: parseHexArray(input.pathSiblings),
  };
}

export function parseProvenPositionClose(input: PositionCloseBody): CreateProvenPositionCloseInput {
  return {
    marketId: String(input.marketId),
    markPrice: BigInt(String(input.markPrice)),
    positionCommitment: String(input.positionCommitment) as `0x${string}`,
    positionNullifier: String(input.positionNullifier) as `0x${string}`,
    positionRoot: String(input.positionRoot) as `0x${string}`,
    closeCommitment: String(input.closeCommitment) as `0x${string}`,
    newPositionCommitment: String(input.newPositionCommitment) as `0x${string}`,
    marginOutputCommitment: String(input.marginOutputCommitment) as `0x${string}`,
    proof: parseProofMeta(requiredObject(input.proof, "proof")),
  };
}

function parseBooleanArray(value: unknown): boolean[] {
  if (!Array.isArray(value)) throw new Error("pathIndices must be an array");
  return value.map((entry) => entry === true || entry === "true");
}

function parseHexArray(value: unknown): `0x${string}`[] {
  if (!Array.isArray(value)) throw new Error("pathSiblings must be an array");
  return value.map((entry) => String(entry) as `0x${string}`);
}

function requiredObject(value: unknown, field: string): PositionCloseBody {
  if (!value || typeof value !== "object") throw new Error(`${field} is required`);
  return value as PositionCloseBody;
}
