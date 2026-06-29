import type { Hex, IntentRecord, OrderLifecycleRecord } from "@merkl/protocol-types";
import type { CreateIntentInput } from "../intents/intents.model";

export interface CancelOrderInput {
  intentCommitment: Hex;
}

export interface CancelOrderResult {
  order: OrderLifecycleRecord;
}

export interface ReplaceOrderInput {
  intentCommitment: Hex;
  replacement: CreateIntentInput;
}

export interface ReplaceOrderResult {
  cancelledOrder: OrderLifecycleRecord;
  replacementIntent: IntentRecord;
}
