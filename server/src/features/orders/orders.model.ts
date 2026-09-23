import type { DepositNoteRecord, Hex, IntentRecord, OrderLifecycleRecord } from "@pnlx/protocol-types";
import type { CreateIntentInput } from "@/features/intents/intents.model";

export interface CancelOrderInput {
  intentCommitment: Hex;
}

export interface CancelOrderResult {
  order: OrderLifecycleRecord;
}

export interface ResidualClaimDetails {
  amount: bigint;
  claimedCommitment?: Hex;
  tokenDigest: Hex;
}

export interface ClaimResidualInput {
  intentCommitment: Hex;
  depositProof: DepositNoteRecord;
}

export interface ClaimResidualResult {
  amount: bigint;
  commitment: Hex;
  claimTxHash?: Hex;
}

export interface ReplaceOrderInput {
  intentCommitment: Hex;
  replacement: CreateIntentInput;
}

export interface ReplaceOrderResult {
  cancelledOrder: OrderLifecycleRecord;
  replacementIntent: IntentRecord;
}
