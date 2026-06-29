import type {
  CreateConditionalOrderInput,
  CreateProvenConditionalOrderInput,
  ExecuteConditionalCloseInput,
  RegisterConditionalOrderInput,
} from "@/features/conditional-orders/conditional-orders.model";
import { parsePositionClose } from "@/features/position-closes/position-closes.schema";
import { parseProofMeta } from "@/features/intents/intents.schema";

type ConditionalOrderBody = Record<string, unknown>;

export function parseConditionalOrderRegistration(
  input: ConditionalOrderBody,
): RegisterConditionalOrderInput {
  return {
    marketId: String(input.marketId),
    positionNullifier: String(input.positionNullifier) as `0x${string}`,
    closeCommitment: String(input.closeCommitment) as `0x${string}`,
  };
}

export function parseConditionalOrder(input: ConditionalOrderBody): CreateConditionalOrderInput {
  return {
    marketId: String(input.marketId),
    positionNullifier: String(input.positionNullifier) as `0x${string}`,
    side: input.side === "short" ? "short" : "long",
    kind: input.kind === "stop-loss" ? "stop-loss" : "take-profit",
    triggerPrice: BigInt(String(input.triggerPrice)),
    markPrice: BigInt(String(input.markPrice)),
    size: BigInt(String(input.size)),
    reduceOnly: parseBoolean(input.reduceOnly),
    salt: String(input.salt),
  };
}

export function parseProvenConditionalOrder(
  input: ConditionalOrderBody,
): CreateProvenConditionalOrderInput {
  return {
    marketId: String(input.marketId),
    markPrice: BigInt(String(input.markPrice)),
    positionNullifier: String(input.positionNullifier) as `0x${string}`,
    closeCommitment: String(input.closeCommitment) as `0x${string}`,
    proof: parseProofMeta(requiredObject(input.proof, "proof")),
  };
}

export function parseExecuteConditionalClose(input: ConditionalOrderBody): ExecuteConditionalCloseInput {
  return {
    close: parsePositionClose(requiredObject(input.close, "close")),
    trigger: parseConditionalOrder(requiredObject(input.trigger, "trigger")),
  };
}

function parseBoolean(value: unknown): boolean {
  return value === true || value === "true" || value === "1";
}

function requiredObject(value: unknown, field: string): ConditionalOrderBody {
  if (!value || typeof value !== "object") throw new Error(`${field} is required`);
  return value as ConditionalOrderBody;
}
