import type { Hex, IntentValidityRecord, TradeIntent } from "@pnlx/protocol-types";
import type { PreparedIntentSubmission } from "@/workers/executor/executor.model";

export interface PendingIntentSubmission {
  intentCommitment: Hex;
  createdAt: number;
  intent: TradeIntent;
  validity: IntentValidityRecord;
  prepared: PreparedIntentSubmission;
  replacementOf?: Hex;
  conditionalPolicy?: unknown;
}

export function assertIdenticalIntentSubmission(previous: PendingIntentSubmission, next: PendingIntentSubmission): void {
  const serialize = (value: PendingIntentSubmission) => JSON.stringify({ intent: value.intent,
    validity: value.validity, prepared: value.prepared, replacementOf: value.replacementOf,
    conditionalPolicy: value.conditionalPolicy },
  (_key, item) => {
    if (typeof item === "bigint") return { __pnlxBigInt: item.toString() };
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]));
    }
    return item;
  });
  if (serialize(previous) !== serialize(next)) throw new Error("conflicting prepared intent submission");
}

export function copyIntentSubmission(record: PendingIntentSubmission): PendingIntentSubmission {
  // Bun 1.3.9 structuredClone corrupts shared object references in this BigInt graph.
  return JSON.parse(JSON.stringify(record, (_key, value) =>
    typeof value === "bigint" ? { __pnlxBigInt: value.toString() } : value), (_key, value) =>
    value && typeof value === "object" && typeof value.__pnlxBigInt === "string"
      ? BigInt(value.__pnlxBigInt) : value) as PendingIntentSubmission;
}
