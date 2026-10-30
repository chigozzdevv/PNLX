import { describe, expect, test } from "bun:test";
import { ProtocolStore } from "@/shared/state/store";
import { assertPositionMutationReady } from "./position-mutation";
import type { FundingCycleRecord, Hex } from "@pnlx/protocol-types";

const id = "0x01" as Hex, other = "0x02" as Hex;
const cycle = (): FundingCycleRecord => ({ cycleId: id, marketId: "xlm-usd-perp", windowStart: 0,
  windowEnd: 3_600_000, intervalMs: 3_600_000, status: "attempted", oldFundingIndex: 0n,
  newFundingIndex: 1n, markPrice: 100n, premiumRate: 1n, submissionAttempted: true, updatedAt: 3_600_000 });

describe("funding and position mutation coordination", () => {
  test("an uncertain funding attempt blocks new batches and closes but permits its own exact recovery", () => {
    const store = new ProtocolStore();
    store.fundingCycles.set(id, cycle());
    for (const kind of ["batch", "pair", "funding"] as const) {
      expect(() => assertPositionMutationReady(store, kind, other)).toThrow("pending funding");
    }
    expect(() => assertPositionMutationReady(store, "funding", id)).not.toThrow();
  });

  test("only settled or authoritatively failed attempted funding releases other mutations", () => {
    const store = new ProtocolStore();
    store.fundingCycles.set(id, { ...cycle(), status: "retired" });
    expect(() => assertPositionMutationReady(store, "batch", other)).toThrow("pending funding");
    store.fundingCycles.set(id, { ...cycle(), status: "retired", failureConfirmed: true });
    expect(() => assertPositionMutationReady(store, "batch", other)).not.toThrow();
    store.fundingCycles.set(id, { ...cycle(), status: "settled" });
    expect(() => assertPositionMutationReady(store, "pair", other)).not.toThrow();
  });

  test("an uncertain batch cannot be bypassed by a funding update", () => {
    const store = new ProtocolStore();
    store.batchExecutionRuns.set(other, { runId: other, batchId: "pending", marketId: "xlm-usd-perp",
      status: "failed", startedAt: 1, submissionAttempted: true, settlementDigest: id });
    expect(() => assertPositionMutationReady(store, "funding", id)).toThrow("pending batch");
    expect(() => assertPositionMutationReady(store, "batch", other)).not.toThrow();
  });
});
