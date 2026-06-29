import type { Hex } from "@merkl/protocol-types";
import { parseIntent } from "@/features/intents/intents.schema";
import type { CancelOrderInput, ReplaceOrderInput } from "@/features/orders/orders.model";

type OrderBody = Record<string, unknown>;

export function parseCancelOrder(input: OrderBody): CancelOrderInput {
  return {
    intentCommitment: String(input.intentCommitment) as Hex,
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
