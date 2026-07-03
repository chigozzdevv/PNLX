import { hashFields } from "@pnlx/crypto";
import type { Hex, IntentRecord, PrivateMatchIntent, ResidualOrderRecord, TradeIntent } from "@pnlx/protocol-types";

const ZERO_HEX = "0x0" as Hex;

export function privateMatchIntentFromTradeIntent(input: {
  intent: TradeIntent;
  intentCommitment: Hex;
  noteChangeCommitment: Hex;
  ownerCommitment: Hex;
}): PrivateMatchIntent {
  return {
    batchId: input.intent.batchId,
    intentCommitment: input.intentCommitment,
    limitPrice: input.intent.limitPrice,
    margin: input.intent.margin,
    marketId: input.intent.marketId,
    noteChangeCommitment: input.noteChangeCommitment,
    noteNullifier: input.intent.noteNullifier,
    ownerCommitment: input.ownerCommitment,
    signedSize: input.intent.side === "long" ? input.intent.size : -input.intent.size,
  };
}

export function matchingPayloadCommitment(payload: PrivateMatchIntent): Hex {
  return hashFields("matching-payload", [
    payload.intentCommitment,
    payload.marketId,
    payload.ownerCommitment,
    payload.signedSize,
    payload.limitPrice,
    payload.margin,
    payload.noteNullifier,
    payload.noteChangeCommitment,
    payload.sourceIntentCommitment ?? "0x0",
  ]);
}

export function assertPrivateMatchIntent(
  record: Pick<
    IntentRecord | ResidualOrderRecord,
    | "batchId"
    | "intentCommitment"
    | "marketId"
    | "matchingPayloadCommitment"
    | "noteNullifier"
    | "ownerCommitment"
  > & { noteChangeCommitment?: Hex },
  payload: PrivateMatchIntent,
): void {
  if (payload.intentCommitment !== record.intentCommitment) throw new Error("private match payload intent mismatch");
  if (payload.marketId !== record.marketId) throw new Error("private match payload market mismatch");
  if (payload.ownerCommitment !== record.ownerCommitment) throw new Error("private match payload owner mismatch");
  if (payload.noteNullifier !== record.noteNullifier) throw new Error("private match payload nullifier mismatch");
  if ("noteChangeCommitment" in record && payload.noteChangeCommitment !== record.noteChangeCommitment) {
    throw new Error("private match payload change commitment mismatch");
  }
  if (!("noteChangeCommitment" in record) && payload.noteChangeCommitment !== ZERO_HEX) {
    throw new Error("residual private match payload cannot carry a note change");
  }
  if (matchingPayloadCommitment(payload) !== record.matchingPayloadCommitment) {
    throw new Error("private match payload commitment mismatch");
  }
}
