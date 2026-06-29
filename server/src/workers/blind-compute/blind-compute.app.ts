import type { Hex, IntentRecord, MarketConfig, ProofMeta, ResidualOrderRecord } from "@merkl/protocol-types";
import { json, readJson } from "../../shared/http/json";
import { Router } from "../../shared/http/router";
import { BlindComputeService } from "./blind-compute.service";
import type { BlindComputeConfig, BlindComputeSettlementRequest } from "./blind-compute.model";

type Body = Record<string, unknown>;

export interface BlindComputeAppOptions extends BlindComputeConfig {
  token?: string;
}

export function createBlindComputeApp(options: BlindComputeAppOptions): Router {
  const router = new Router();
  const compute = new BlindComputeService(options);

  router.add("POST", "/compute/settlement", async (request) => {
    assertComputeAuth(request, options.token);
    const body = await readJson<Body>(request);
    return json(compute.createSettlementTranscript(parseSettlementRequest(body)), 201);
  }, { public: true });

  return router;
}

export function parseSettlementRequest(input: Body): BlindComputeSettlementRequest {
  return {
    batchId: String(input.batchId),
    market: parseMarket(requiredObject(input.market, "market")),
    oldRoot: hex(input.oldRoot, "oldRoot"),
    positionCommitments: parseHexArray(input.positionCommitments, "positionCommitments"),
    records: parseIntentRecords(input.records),
    residuals: parseResidualOrders(input.residuals),
  };
}

function parseMarket(input: Body): MarketConfig {
  return {
    fundingIndex: BigInt(String(input.fundingIndex)),
    initialMarginRate: BigInt(String(input.initialMarginRate)),
    maintenanceMarginRate: BigInt(String(input.maintenanceMarginRate)),
    marketId: String(input.marketId),
    maxLeverage: BigInt(String(input.maxLeverage)),
    oraclePrice: BigInt(String(input.oraclePrice)),
  };
}

function parseIntentRecords(value: unknown): IntentRecord[] {
  if (!Array.isArray(value)) throw new Error("records must be an array");
  return value.map((entry) => {
    const body = requiredObject(entry, "intent record");
    return {
      batchDigest: hex(body.batchDigest, "batchDigest"),
      batchId: String(body.batchId),
      intentCommitment: hex(body.intentCommitment, "intentCommitment"),
      marginRoot: hex(body.marginRoot, "marginRoot"),
      marketDigest: hex(body.marketDigest, "marketDigest"),
      marketId: String(body.marketId),
      noteNullifier: hex(body.noteNullifier, "noteNullifier"),
      ownerCommitment: hex(body.ownerCommitment, "ownerCommitment"),
      ownerCommitmentField: hex(body.ownerCommitmentField, "ownerCommitmentField"),
      proof: parseProof(requiredObject(body.proof, "proof")),
      shareCommitment: hex(body.shareCommitment, "shareCommitment"),
    };
  });
}

function parseResidualOrders(value: unknown): ResidualOrderRecord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("residuals must be an array");
  return value.map((entry) => {
    const body = requiredObject(entry, "residual order");
    return {
      batchId: String(body.batchId),
      createdAt: Number(body.createdAt),
      intentCommitment: hex(body.intentCommitment, "intentCommitment"),
      marketId: String(body.marketId),
      noteNullifier: hex(body.noteNullifier, "noteNullifier"),
      ownerCommitment: hex(body.ownerCommitment, "ownerCommitment"),
      shareCommitment: hex(body.shareCommitment, "shareCommitment"),
      sourceIntentCommitment: hex(body.sourceIntentCommitment, "sourceIntentCommitment"),
      updatedAt: Number(body.updatedAt),
    };
  });
}

function parseProof(input: Body): ProofMeta {
  return {
    bytecodeHash: optionalHex(input.bytecodeHash),
    circuitHash: hex(input.circuitHash, "circuitHash"),
    circuitId: String(input.circuitId),
    circuitKey: hex(input.circuitKey, "circuitKey"),
    proofDigest: hex(input.proofDigest, "proofDigest"),
    proofHash: optionalHex(input.proofHash),
    publicInputHash: hex(input.publicInputHash, "publicInputHash"),
    publicInputsHash: optionalHex(input.publicInputsHash),
    verifierHash: hex(input.verifierHash, "verifierHash"),
    vkHash: optionalHex(input.vkHash),
    witnessHash: optionalHex(input.witnessHash),
  };
}

function parseHexArray(value: unknown, field: string): Hex[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((entry) => hex(entry, field));
}

function hex(value: unknown, field: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`${field} must be hex`);
  }
  return value.toLowerCase() as Hex;
}

function optionalHex(value: unknown): Hex | undefined {
  return value === undefined || value === "" ? undefined : hex(value, "optional hex");
}

function requiredObject(value: unknown, field: string): Body {
  if (!value || typeof value !== "object") throw new Error(`${field} is required`);
  return value as Body;
}

function assertComputeAuth(request: Request, token: string | undefined): void {
  if (!token) return;
  const header = request.headers.get("authorization") ?? "";
  if (header !== `Bearer ${token}`) {
    throw new Error("invalid blind compute api token");
  }
}
