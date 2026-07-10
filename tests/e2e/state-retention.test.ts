import { describe, expect, test } from "bun:test";
import { hashFields } from "@pnlx/crypto";
import type { BatchExecutionRunRecord, Hex } from "@pnlx/protocol-types";
import {
  BATCH_EXECUTION_RUN_RETENTION,
  ProtocolStore,
} from "@/shared/state/store";
import {
  applyProtocolStoreSnapshot,
  snapshotProtocolStore,
} from "@/shared/state/protocol-snapshot";

function run(index: number): BatchExecutionRunRecord {
  return {
    batchId: `batch-${index}`,
    completedAt: index,
    marketId: "xlm-usd-perp",
    runId: hashFields("retention-run", [index]),
    startedAt: index,
    status: "skipped",
  };
}

describe("batch execution run retention", () => {
  test("keeps only the newest bounded history", () => {
    const store = new ProtocolStore();
    for (let index = 0; index < BATCH_EXECUTION_RUN_RETENTION + 5; index += 1) {
      store.addBatchExecutionRun(run(index));
    }

    expect(store.batchExecutionRuns.size).toBe(BATCH_EXECUTION_RUN_RETENTION);
    expect(store.batchExecutionRuns.has(run(0).runId)).toBe(false);
    expect(store.batchExecutionRuns.has(run(5).runId)).toBe(true);
    expect(snapshotProtocolStore(store).batchExecutionRuns).toHaveLength(
      BATCH_EXECUTION_RUN_RETENTION,
    );
  });

  test("trims oversized legacy snapshots while loading", () => {
    const entries: [Hex, BatchExecutionRunRecord][] = [];
    for (let index = 0; index < BATCH_EXECUTION_RUN_RETENTION + 10; index += 1) {
      const record = run(index);
      entries.push([record.runId, record]);
    }
    const store = new ProtocolStore();
    applyProtocolStoreSnapshot(store, { batchExecutionRuns: entries });

    expect(store.batchExecutionRuns.size).toBe(BATCH_EXECUTION_RUN_RETENTION);
    expect(store.batchExecutionRuns.has(entries[9][0])).toBe(false);
    expect(store.batchExecutionRuns.has(entries[10][0])).toBe(true);
  });
});
