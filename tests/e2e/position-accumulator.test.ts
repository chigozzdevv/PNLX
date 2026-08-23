import { describe, expect, setSystemTime, test } from "bun:test";
import {
  positionMerkleProof,
  positionMerkleRoot,
} from "@pnlx/crypto";
import type { Hex } from "@pnlx/protocol-types";
import { MatcherJobService } from "@/workers/matcher/matcher-job.service";

describe("canonical position accumulator", () => {
  test("matches the on-chain depth-twenty append vector", () => {
    const first = `0x${"09".repeat(32)}` as Hex;
    expect(positionMerkleRoot([])).toBe(
      "0x00000000000000000000000028beb7912414d9730045896cfebc5404cb44132d",
    );
    expect(positionMerkleRoot([first])).toBe(
      "0x10f0c78e165c675e0f252bbd8415e98c6cd8afe0f0aa485e53648653766cd20b",
    );
    const proof = positionMerkleProof([first], first);
    expect(proof.index).toBe(0);
    expect(proof.siblings).toHaveLength(20);
    expect(proof.indices).toEqual(Array(20).fill(false));
  });

  test("keeps an earlier membership root valid after later appends", () => {
    const first = `0x${"01".repeat(32)}` as Hex;
    const second = `0x${"02".repeat(32)}` as Hex;
    const historical = positionMerkleProof([first], first);
    const current = positionMerkleProof([first, second], first);

    expect(historical.root).not.toBe(current.root);
    expect(historical.leaf).toBe(current.leaf);
    expect(historical.index).toBe(current.index);
  });
});

describe("matcher proof jobs", () => {
  test("deduplicates an in-flight batch and returns its completed transcript", async () => {
    let resolveProof!: () => void;
    let calls = 0;
    const proof = new Promise<void>((resolve) => {
      resolveProof = resolve;
    });
    const jobs = MatcherJobService.memory(async () => {
      calls += 1;
      await proof;
      return {
        accountEvents: [],
        positionOpenings: [],
        settlement: { batchId: "batch-a" },
      } as never;
    });
    const input = { batchId: "batch-a", marketId: "xlm-usd-perp" };

    const first = await jobs.enqueue(input);
    const second = await jobs.enqueue(input);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(first.jobId).toBe(second.jobId);
    expect((await jobs.get(first.jobId)).status).toBe("proving");
    expect(calls).toBe(1);
    resolveProof();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await jobs.get(first.jobId)).status).toBe("completed");
  });

  test("requeues a failed proof job when its retry delay has elapsed", async () => {
    const startedAt = new Date("2026-08-23T00:00:00.000Z");
    setSystemTime(startedAt);
    let calls = 0;
    const jobs = MatcherJobService.memory(async () => {
      calls += 1;
      if (calls === 1) throw new Error("temporary proof failure");
      return {
        accountEvents: [],
        positionOpenings: [],
        settlement: { batchId: "batch-retry" },
      } as never;
    });

    try {
      const input = { batchId: "batch-retry", marketId: "xlm-usd-perp" };
      const queued = await jobs.enqueue(input);
      await waitForJobStatus(jobs, queued.jobId, "failed");
      const failed = await jobs.get(queued.jobId);
      expect(failed).toMatchObject({ attempts: 1, status: "failed" });
      expect(failed.nextAttemptAt).toBe(startedAt.getTime() + 5 * 60_000);

      setSystemTime(new Date(startedAt.getTime() + 5 * 60_000));
      await jobs.enqueue(input);
      const completed = await waitForJobStatus(jobs, queued.jobId, "completed");
      expect(completed).toMatchObject({ attempts: 2, status: "completed" });
      expect(calls).toBe(2);
    } finally {
      setSystemTime();
    }
  });
});

async function waitForJobStatus(
  jobs: MatcherJobService,
  jobId: string,
  status: "completed" | "failed",
) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const job = await jobs.get(jobId);
    if (job.status === status) return job;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`matcher job did not reach ${status}`);
}
