import type { Hex } from "@pnlx/protocol-types";
import type { ProtocolStore } from "@/shared/state/store";
import { BatchMatcherService } from "@/workers/batch-matcher/batch-matcher.service";
import { assertBatchSettlementCapacity, MAX_PUBLIC_ITEMS } from "@/shared/protocol/batch-settlement-proof";

import { MAX_BATCH_EXECUTIONS } from "@/shared/protocol/batch-budget";

export interface BatchSelectionExclusions {
  intentCommitments: Set<string>;
  noteNullifiers: Set<string>;
}

/** Include ancestors so a residual cannot race a reserved use of its source note. */
export function batchSelectionInputs(store: ProtocolStore, ids: readonly Hex[]): BatchSelectionExclusions {
  const intentCommitments = new Set<string>();
  const noteNullifiers = new Set<string>();
  for (const id of ids) {
    let current: Hex | undefined = id;
    const visited = new Set<string>();
    while (current) {
      const normalized = current.toLowerCase();
      if (visited.has(normalized)) throw new Error("cyclic batch reservation lineage; reconciliation required");
      if (intentCommitments.has(normalized)) throw new Error("batch selection shares an intent lineage; reconciliation required");
      visited.add(normalized);
      intentCommitments.add(normalized);
      const payload = store.privateMatchIntents.get(current);
      const record = store.intents.get(current) ?? store.residualOrders.get(current);
      if (!payload || !record || payload.noteNullifier !== record.noteNullifier) {
        throw new Error("batch reservation input is unavailable; reconciliation required");
      }
      const nullifier = payload.noteNullifier.toLowerCase();
      if (noteNullifiers.has(nullifier)) throw new Error("batch selection shares a note nullifier; reconciliation required");
      noteNullifiers.add(nullifier);
      const parent: Hex | undefined = store.residualOrders.get(current)?.sourceIntentCommitment;
      if (parent && payload.sourceIntentCommitment && parent !== payload.sourceIntentCommitment) {
        throw new Error("batch reservation lineage mismatch; reconciliation required");
      }
      current = parent ?? payload.sourceIntentCommitment;
    }
  }
  return { intentCommitments, noteNullifiers };
}

/** A partial first match can create an earlier-priority residual for the next match. */
export function batchSelectionFullyConsumes(store: ProtocolStore, marketId: string, ids: readonly Hex[]): boolean {
  if (ids.length !== 2 || new Set(ids).size !== 2) throw new Error("invalid single-execution selection; reconciliation required");
  batchSelectionInputs(store, ids);
  const [first, second] = ids.map((id) => store.privateMatchIntents.get(id)!);
  if (first!.marketId !== marketId || second!.marketId !== marketId ||
      typeof first!.signedSize !== "bigint" || typeof second!.signedSize !== "bigint" ||
      first!.signedSize === 0n || second!.signedSize === 0n ||
      (first!.signedSize > 0n) === (second!.signedSize > 0n)) {
    throw new Error("invalid single-execution inputs; reconciliation required");
  }
  return first!.signedSize === -second!.signedSize;
}

export function capacityBoundedIntentCommitments(
  store: ProtocolStore,
  marketId: string,
  batchId: string,
  excluded?: BatchSelectionExclusions,
): Hex[] {
  const market = store.markets.get(marketId);
  if (!market) throw new Error("unknown market");
  const orders = [...store.orderLifecycle.values()]
    .filter((order) => order.marketId === marketId && order.status === "open")
    .sort((left, right) => {
      const a = store.intents.get(left.intentCommitment)?.submissionSequence ??
        store.residualOrders.get(left.intentCommitment)?.submissionSequence;
      const b = store.intents.get(right.intentCommitment)?.submissionSequence ??
        store.residualOrders.get(right.intentCommitment)?.submissionSequence;
      if (a !== undefined && b !== undefined && a !== b) return a < b ? -1 : 1;
      return left.createdAt - right.createdAt || left.intentCommitment.localeCompare(right.intentCommitment);
    });
  const intents = orders.map((order) => {
    const payload = store.privateMatchIntents.get(order.intentCommitment);
    if (!payload) throw new Error("private match payload not found");
    return payload;
  }).filter((intent) => {
    if (!excluded) return true;
    const inputs = batchSelectionInputs(store, [intent.intentCommitment]);
    return ![...inputs.intentCommitments].some((id) => excluded.intentCommitments.has(id)) &&
      ![...inputs.noteNullifiers].some((id) => excluded.noteNullifiers.has(id));
  });
  if (intents.length < 2) return intents.map((intent) => intent.intentCommitment);
  const matcher = new BatchMatcherService();
  const book = intents.map((intent, sequence) => ({
    intent, sequence, remaining: intent.signedSize < 0n ? -intent.signedSize : intent.signedSize,
  }));
  const longs = book.filter((order) => order.intent.signedSize > 0n)
    .sort((a, b) => a.intent.limitPrice === b.intent.limitPrice ? a.sequence - b.sequence
      : a.intent.limitPrice > b.intent.limitPrice ? -1 : 1);
  const shorts = book.filter((order) => order.intent.signedSize < 0n)
    .sort((a, b) => a.intent.limitPrice === b.intent.limitPrice ? a.sequence - b.sequence
      : a.intent.limitPrice < b.intent.limitPrice ? -1 : 1);
  // Keep the first executable price/time-priority prefix; unconsumed orders stay open.
  const selected = new Set<Hex>();
  let longIndex = 0;
  let shortIndex = 0;
  for (let execution = 0; execution < Math.min(MAX_BATCH_EXECUTIONS, Math.floor(MAX_PUBLIC_ITEMS / 2)); execution += 1) {
    const long = longs[longIndex];
    const short = shorts[shortIndex];
    if (!long || !short || long.intent.limitPrice < short.intent.limitPrice) break;
    const size = long.remaining < short.remaining ? long.remaining : short.remaining;
    selected.add(long.intent.intentCommitment);
    selected.add(short.intent.intentCommitment);
    long.remaining -= size;
    short.remaining -= size;
    if (long.remaining === 0n) longIndex += 1;
    if (short.remaining === 0n) shortIndex += 1;
  }
  if (selected.size === 0) throw new Error("batch has no crossed liquidity");
  const packed = intents.filter((intent) => selected.has(intent.intentCommitment));
  const preflight = matcher.match({ batchId, intents: packed, market });
  assertBatchSettlementCapacity({ ...preflight,
    newCommitments: preflight.fills.map((fill) => fill.positionCommitment),
  }, preflight.executions.length);
  return packed.map((intent) => intent.intentCommitment);
}
