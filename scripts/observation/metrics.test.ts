import { expect, test } from "bun:test";
import { publicRunTiming } from "./metrics";

test("extracts only timings for this run and drops private recovery material", () => {
  const runId = `0x${"a".repeat(64)}`;
  const result = publicRunTiming({ runId, startedAt: 10, completedAt: 40,
    phaseTimestamps: { matcher: 12, proving: 20, "batch-settlement": 30, unknown: 99 },
    settlementTranscript: { witness: "private" }, intentCommitments: ["private selection"] }, new Set([runId]));
  expect(result).toEqual({ runId, startedAt: 10, completedAt: 40,
    phaseTimestamps: { matcher: 12, proving: 20, "batch-settlement": 30 } });
  expect(JSON.stringify(result)).not.toContain("private");
  expect(publicRunTiming({ runId, startedAt: 10 }, new Set())).toBeUndefined();
});
test("does not turn invalid or absent timestamps into measurements", () => {
  const runId = `0x${"b".repeat(64)}`;
  expect(publicRunTiming({ runId, startedAt: 0 }, new Set([runId]))).toBeUndefined();
  expect(publicRunTiming({ runId, startedAt: 10, completedAt: NaN,
    phaseTimestamps: { proving: -1, matcher: "12" } }, new Set([runId]))).toEqual({ runId, startedAt: 10, phaseTimestamps: {} });
});
