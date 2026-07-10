import { describe, expect, test } from "bun:test";
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
});
