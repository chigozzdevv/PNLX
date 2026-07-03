import type {
  CommitExternalBatchSettlementRequest,
  SettleBatchRequest,
} from "@/features/batches/batches.model";
import { parseProofMeta } from "@/features/intents/intents.schema";

type BatchBody = Record<string, unknown>;
const ZERO_HEX = "0x0" as `0x${string}`;

export function parseSettleBatch(input: {
  batchId: string;
  marketId: string;
}): SettleBatchRequest {
  return {
    batchId: input.batchId,
    marketId: input.marketId,
  };
}

export function parseExternalBatchSettlement(input: BatchBody): CommitExternalBatchSettlementRequest {
  const settlement = requiredObject(input.settlement, "settlement");
  return {
    accountEvents: parseAccountEvents(input.accountEvents),
    settlement: {
      batchId: String(settlement.batchId),
      marketId: String(settlement.marketId),
      oldRoot: String(settlement.oldRoot) as `0x${string}`,
      newRoot: String(settlement.newRoot) as `0x${string}`,
      matchTranscriptDigest: String(settlement.matchTranscriptDigest) as `0x${string}`,
      settlementDigest: String(settlement.settlementDigest) as `0x${string}`,
      newCommitments: parseHexArray(settlement.newCommitments),
      marginChangeCommitments: parseHexArray(settlement.marginChangeCommitments),
      spentNullifiers: parseHexArray(settlement.spentNullifiers),
      fillCount: Number(settlement.fillCount),
      aggregateVolume: BigInt(String(settlement.aggregateVolume)),
      openInterestDelta: BigInt(String(settlement.openInterestDelta)),
      orderUpdates: parseOrderUpdates(settlement.orderUpdates),
      residualSize: BigInt(String(settlement.residualSize)),
      proof: parseProofMeta(requiredObject(settlement.proof, "proof")),
    },
    privateMatchIntents: parsePrivateMatchIntents(input.privateMatchIntents),
    positionOpenings: parsePositionOpenings(input.positionOpenings),
    residualOrders: parseResidualOrders(input.residualOrders),
  };
}

function parseOrderUpdates(value: unknown): CommitExternalBatchSettlementRequest["settlement"]["orderUpdates"] {
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
      intentCommitment: String(body.intentCommitment) as `0x${string}`,
      residualCommitment: body.residualCommitment
        ? String(body.residualCommitment) as `0x${string}`
        : undefined,
      status,
    };
  });
}

function parsePositionOpenings(value: unknown): CommitExternalBatchSettlementRequest["positionOpenings"] {
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
      ownerCommitment: String(body.ownerCommitment) as `0x${string}`,
      positionCommitment: String(body.positionCommitment) as `0x${string}`,
      positionNullifier: String(body.positionNullifier) as `0x${string}`,
      settlementDigest: String(body.settlementDigest) as `0x${string}`,
      sourceIntentCommitment: String(body.sourceIntentCommitment) as `0x${string}`,
      status,
      updatedAt: Number(body.updatedAt),
    };
  });
}

function parseResidualOrders(value: unknown): CommitExternalBatchSettlementRequest["residualOrders"] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("residualOrders must be an array");
  return value.map((entry) => {
    const body = requiredObject(entry, "residualOrder");
    return {
      batchId: String(body.batchId),
      createdAt: Number(body.createdAt),
      intentCommitment: String(body.intentCommitment) as `0x${string}`,
      marketId: String(body.marketId),
      matchingPayloadCommitment: String(body.matchingPayloadCommitment) as `0x${string}`,
      noteNullifier: String(body.noteNullifier) as `0x${string}`,
      ownerCommitment: String(body.ownerCommitment) as `0x${string}`,
      sourceIntentCommitment: String(body.sourceIntentCommitment) as `0x${string}`,
      updatedAt: Number(body.updatedAt),
    };
  });
}

function parsePrivateMatchIntents(value: unknown): CommitExternalBatchSettlementRequest["privateMatchIntents"] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("privateMatchIntents must be an array");
  return value.map((entry) => {
    const body = requiredObject(entry, "privateMatchIntent");
    return {
      batchId: String(body.batchId),
      intentCommitment: String(body.intentCommitment) as `0x${string}`,
      limitPrice: BigInt(String(body.limitPrice)),
      margin: BigInt(String(body.margin)),
      marketId: String(body.marketId),
      noteChangeCommitment: optionalHex(body.noteChangeCommitment) ?? ZERO_HEX,
      noteNullifier: String(body.noteNullifier) as `0x${string}`,
      ownerCommitment: String(body.ownerCommitment) as `0x${string}`,
      signedSize: BigInt(String(body.signedSize)),
      sourceIntentCommitment: optionalHex(body.sourceIntentCommitment),
    };
  });
}

function parseAccountEvents(value: unknown): CommitExternalBatchSettlementRequest["accountEvents"] {
  if (!Array.isArray(value)) throw new Error("accountEvents must be an array");
  return value.map((entry) => {
    const body = requiredObject(entry, "accountEvent");
    const ciphertext = String(body.ciphertext ?? "").trim();
    if (!ciphertext) throw new Error("account event ciphertext is required");
    return {
      ciphertext,
      createdAt: Number(body.createdAt),
      dataCommitment: String(body.dataCommitment) as `0x${string}`,
      eventId: String(body.eventId) as `0x${string}`,
      ownerCommitment: String(body.ownerCommitment) as `0x${string}`,
    };
  });
}

function parseHexArray(value: unknown): `0x${string}`[] {
  if (!Array.isArray(value)) throw new Error("expected hex array");
  return value.map((entry) => String(entry) as `0x${string}`);
}

function optionalHex(value: unknown): `0x${string}` | undefined {
  return value ? String(value) as `0x${string}` : undefined;
}

function requiredObject(value: unknown, field: string): BatchBody {
  if (!value || typeof value !== "object") throw new Error(`${field} is required`);
  return value as BatchBody;
}
