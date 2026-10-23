import type { Hex } from "@pnlx/protocol-types";
import type { ProtocolStore } from "@/shared/state/store";

const POSITION_MUTATIONS = new WeakMap<object, Promise<unknown>>();

// Keep authoritative chain append order and local membership mirroring together.
export async function withPositionMutation<T>(store: object, work: () => Promise<T>): Promise<T> {
  const previous = POSITION_MUTATIONS.get(store) ?? Promise.resolve();
  const task = previous.catch(() => undefined).then(work);
  POSITION_MUTATIONS.set(store, task);
  try { return await task; }
  finally { if (POSITION_MUTATIONS.get(store) === task) POSITION_MUTATIONS.delete(store); }
}

export function assertPositionMutationReady(
  store: Pick<ProtocolStore, "batchExecutionRuns" | "settlements" | "pendingPairedCloses" | "positionCloses">,
  kind: "batch" | "pair",
  id: Hex,
): void {
  for (const run of store.batchExecutionRuns.values()) {
    if (!run.submissionAttempted || (kind === "batch" && run.runId.toLowerCase() === id.toLowerCase())) continue;
    const committed = [...store.settlements.values()].some((settlement) =>
      settlement.batchId === run.batchId && settlement.marketId === run.marketId &&
      settlement.settlementDigest === run.settlementDigest);
    if (!committed) throw new Error(`position mutation blocked by pending batch ${run.runId}; reconciliation required`);
  }
  for (const run of store.pendingPairedCloses.values()) {
    if (run.retired || !run.settlementTxHash || (kind === "pair" && run.journalKey.toLowerCase() === id.toLowerCase())) continue;
    if (!run.pair.positions.every((record) => store.positionCloses.has(record.closeCommitment))) {
      throw new Error(`position mutation blocked by pending pair ${run.journalKey}; reconciliation required`);
    }
  }
}
