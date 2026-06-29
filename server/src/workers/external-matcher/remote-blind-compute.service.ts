import type { Hex } from "@merkl/protocol-types";
import { parseProofMeta } from "../../features/intents/intents.schema";
import type {
  CommitteeSettlementInput,
  CommitteeSettlementTranscript,
  PrivatePositionOpeningEvent,
} from "../mpc-node/mpc-node.model";
import type { ProofCoordinatorService } from "../proof-coordinator/proof-coordinator.service";
import type { BlindComputeGateway, RemoteBlindComputeConfig } from "./external-matcher.model";

type ComputeBody = Record<string, unknown>;

export class RemoteBlindComputeClient implements BlindComputeGateway {
  constructor(private readonly config: RemoteBlindComputeConfig) {}

  async createSettlementTranscript(
    input: CommitteeSettlementInput,
    _proofs: ProofCoordinatorService,
  ): Promise<CommitteeSettlementTranscript> {
    const response = await fetch(computeUrl(this.config.url), {
      body: JSON.stringify(input, bigintReplacer),
      headers: {
        "content-type": "application/json",
        ...(this.config.token ? { authorization: `Bearer ${this.config.token}` } : {}),
      },
      method: "POST",
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) as ComputeBody : {};
    if (!response.ok) {
      const message =
        typeof body.error === "string"
          ? body.error
          : `remote blind compute failed with ${response.status}`;
      throw new Error(message);
    }
    return parseCommitteeSettlementTranscript(body);
  }
}

export function parseCommitteeSettlementTranscript(input: ComputeBody): CommitteeSettlementTranscript {
  const settlement = requiredObject(input.settlement, "settlement");
  return {
    positionEvents: parsePositionEvents(input.positionEvents),
    positionOpenings: parsePositionOpenings(input.positionOpenings),
    residualOrders: parseResidualOrders(input.residualOrders),
    settlement: {
      aggregateVolume: BigInt(String(settlement.aggregateVolume)),
      batchId: String(settlement.batchId),
      fillCount: Number(settlement.fillCount),
      marginChangeCommitments: parseHexArray(settlement.marginChangeCommitments),
      marketId: String(settlement.marketId),
      matchTranscriptDigest: String(settlement.matchTranscriptDigest) as Hex,
      newCommitments: parseHexArray(settlement.newCommitments),
      newRoot: String(settlement.newRoot) as Hex,
      oldRoot: String(settlement.oldRoot) as Hex,
      openInterestDelta: BigInt(String(settlement.openInterestDelta)),
      orderUpdates: parseOrderUpdates(settlement.orderUpdates),
      proof: parseProofMeta(requiredObject(settlement.proof, "proof")),
      residualSize: BigInt(String(settlement.residualSize)),
      settlementDigest: String(settlement.settlementDigest) as Hex,
      spentNullifiers: parseHexArray(settlement.spentNullifiers),
    },
  };
}

function parsePositionEvents(value: unknown): PrivatePositionOpeningEvent[] {
  if (!Array.isArray(value)) throw new Error("positionEvents must be an array");
  return value.map((entry) => {
    const body = requiredObject(entry, "positionEvent");
    const side = String(body.side);
    if (side !== "long" && side !== "short") throw new Error("invalid position event side");
    return {
      entryPrice: BigInt(String(body.entryPrice)),
      fundingIndex: BigInt(String(body.fundingIndex)),
      margin: BigInt(String(body.margin)),
      marketId: String(body.marketId),
      positionCommitment: String(body.positionCommitment) as Hex,
      positionNullifier: String(body.positionNullifier) as Hex,
      side,
      size: BigInt(String(body.size)),
      sourceIntentCommitment: String(body.sourceIntentCommitment) as Hex,
    };
  });
}

function parsePositionOpenings(value: unknown): CommitteeSettlementTranscript["positionOpenings"] {
  if (!Array.isArray(value)) throw new Error("positionOpenings must be an array");
  return value.map((entry) => {
    const body = requiredObject(entry, "positionOpening");
    const status = String(body.status);
    if (status !== "open" && status !== "closed" && status !== "liquidated") {
      throw new Error("invalid position status");
    }
    return {
      batchId: String(body.batchId),
      closeCommitment: optionalHex(body.closeCommitment),
      liquidationRewardCommitment: optionalHex(body.liquidationRewardCommitment),
      marginOutputCommitment: optionalHex(body.marginOutputCommitment),
      marketId: String(body.marketId),
      newPositionCommitment: optionalHex(body.newPositionCommitment),
      openedAt: Number(body.openedAt),
      ownerCommitment: String(body.ownerCommitment) as Hex,
      positionCommitment: String(body.positionCommitment) as Hex,
      positionNullifier: String(body.positionNullifier) as Hex,
      settlementDigest: String(body.settlementDigest) as Hex,
      sourceIntentCommitment: String(body.sourceIntentCommitment) as Hex,
      status,
      updatedAt: Number(body.updatedAt),
    };
  });
}

function parseResidualOrders(value: unknown): CommitteeSettlementTranscript["residualOrders"] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("residualOrders must be an array");
  return value.map((entry) => {
    const body = requiredObject(entry, "residualOrder");
    return {
      batchId: String(body.batchId),
      createdAt: Number(body.createdAt),
      intentCommitment: String(body.intentCommitment) as Hex,
      marketId: String(body.marketId),
      noteNullifier: String(body.noteNullifier) as Hex,
      ownerCommitment: String(body.ownerCommitment) as Hex,
      shareCommitment: String(body.shareCommitment) as Hex,
      sourceIntentCommitment: String(body.sourceIntentCommitment) as Hex,
      updatedAt: Number(body.updatedAt),
    };
  });
}

function parseOrderUpdates(value: unknown): CommitteeSettlementTranscript["settlement"]["orderUpdates"] {
  if (!Array.isArray(value)) throw new Error("orderUpdates must be an array");
  return value.map((entry) => {
    const body = requiredObject(entry, "orderUpdate");
    const status = String(body.status);
    if (
      status !== "open" &&
      status !== "partially-filled" &&
      status !== "filled" &&
      status !== "cancelled"
    ) {
      throw new Error("invalid order status");
    }
    return {
      intentCommitment: String(body.intentCommitment) as Hex,
      residualCommitment: optionalHex(body.residualCommitment),
      status,
    };
  });
}

function parseHexArray(value: unknown): Hex[] {
  if (!Array.isArray(value)) throw new Error("expected hex array");
  return value.map((entry) => String(entry) as Hex);
}

function optionalHex(value: unknown): Hex | undefined {
  return value ? String(value) as Hex : undefined;
}

function requiredObject(value: unknown, field: string): ComputeBody {
  if (!value || typeof value !== "object") throw new Error(`${field} is required`);
  return value as ComputeBody;
}

function computeUrl(base: string): string {
  return new URL("/compute/settlement", base).toString();
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}
