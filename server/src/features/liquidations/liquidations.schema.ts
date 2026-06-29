import type { CreateLiquidationInput, CreateProvenLiquidationInput } from "./liquidations.model";
import { parseProofMeta } from "../intents/intents.schema";

type LiquidationBody = Record<string, unknown>;

export function parseLiquidation(input: LiquidationBody): CreateLiquidationInput {
  return {
    marketId: String(input.marketId),
    positionCommitment: String(input.positionCommitment) as `0x${string}`,
    positionNullifier: String(input.positionNullifier) as `0x${string}`,
    positionRoot: String(input.positionRoot) as `0x${string}`,
    rewardCommitment: String(input.rewardCommitment) as `0x${string}`,
    side: input.side === "short" ? "short" : "long",
    size: BigInt(String(input.size)),
    entryPrice: BigInt(String(input.entryPrice)),
    markPrice: BigInt(String(input.markPrice)),
    margin: BigInt(String(input.margin)),
    fundingPayment: BigInt(String(input.fundingPayment)),
    fundingIndex: BigInt(String(input.fundingIndex)),
    maintenanceRate: BigInt(String(input.maintenanceRate)),
    marketDigest: String(input.marketDigest) as `0x${string}`,
    ownerDigest: String(input.ownerDigest) as `0x${string}`,
    rhoDigest: String(input.rhoDigest) as `0x${string}`,
    blinding: String(input.blinding) as `0x${string}`,
    spendSecretDigest: String(input.spendSecretDigest) as `0x${string}`,
    pathIndices: parseBooleanArray(input.pathIndices),
    pathSiblings: parseHexArray(input.pathSiblings),
  };
}

export function parseProvenLiquidation(input: LiquidationBody): CreateProvenLiquidationInput {
  return {
    marketId: String(input.marketId),
    markPrice: BigInt(String(input.markPrice)),
    maintenanceRate: BigInt(String(input.maintenanceRate)),
    positionCommitment: String(input.positionCommitment) as `0x${string}`,
    positionNullifier: String(input.positionNullifier) as `0x${string}`,
    positionRoot: String(input.positionRoot) as `0x${string}`,
    rewardCommitment: String(input.rewardCommitment) as `0x${string}`,
    proof: parseProofMeta(requiredObject(input.proof, "proof")),
  };
}

function requiredObject(value: unknown, field: string): LiquidationBody {
  if (!value || typeof value !== "object") throw new Error(`${field} is required`);
  return value as LiquidationBody;
}

function parseBooleanArray(value: unknown): boolean[] {
  if (!Array.isArray(value)) throw new Error("pathIndices must be an array");
  return value.map((entry) => entry === true || entry === "true");
}

function parseHexArray(value: unknown): `0x${string}`[] {
  if (!Array.isArray(value)) throw new Error("pathSiblings must be an array");
  return value.map((entry) => String(entry) as `0x${string}`);
}
