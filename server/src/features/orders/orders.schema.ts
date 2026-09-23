import type { Hex } from "@pnlx/protocol-types";
import { parseIntent } from "@/features/intents/intents.schema";
import { parseDepositNoteRecord } from "@/features/notes/notes.schema";
import type { CancelOrderInput, ClaimResidualInput, ReplaceOrderInput } from "@/features/orders/orders.model";

type OrderBody = Record<string, unknown>;

export function parseCancelOrder(input: OrderBody): CancelOrderInput {
  return {
    intentCommitment: String(input.intentCommitment) as Hex,
  };
}

export function parseClaimResidual(input: OrderBody): ClaimResidualInput {
  return {
    intentCommitment: String(input.intentCommitment) as Hex,
    depositProof: parseDepositNoteRecord(requiredObject(input.depositProof, "depositProof")),
  };
}

export function parseReplaceOrder(input: OrderBody): ReplaceOrderInput {
  return {
    intentCommitment: String(input.intentCommitment) as Hex,
    replacement: parseIntent(requiredObject(input.replacement, "replacement")),
  };
}

function requiredObject(value: unknown, field: string): OrderBody {
  if (!value || typeof value !== "object") throw new Error(`${field} is required`);
  return value as OrderBody;
}
