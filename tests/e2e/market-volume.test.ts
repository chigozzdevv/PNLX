import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BatchSettlement, Hex, ProofMeta } from "@pnlx/protocol-types";
import { loadEnv } from "@/config/env";
import { MarketsService } from "@/features/markets/markets.service";
import { FileProtocolStore } from "@/shared/state/persistent-store";
import { ProtocolStore } from "@/shared/state/store";
import { ExecutorService } from "@/workers/executor/executor.service";

describe("PNLX market volume", () => {
  test("persists one-sided matched volume when a settlement commits", () => {
    const path = join(mkdtempSync(join(tmpdir(), "pnlx-volume-")), "protocol-store.json");
    const store = new FileProtocolStore(path);
    const proof = proofMeta();
    store.recordProof(proof);

    const before = Date.now();
    store.addSettlement(settlement(proof));
    const after = Date.now();

    const stored = [...store.marketSettlementVolumes.values()];
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      marketId: "xlm-usd-perp",
      matchedVolume: 15_000_000n,
      settlementDigest: "0xsettlement",
    });
    expect(stored[0].settledAt).toBeGreaterThanOrEqual(before);
    expect(stored[0].settledAt).toBeLessThanOrEqual(after);

    const reloaded = new FileProtocolStore(path);
    expect([...reloaded.marketSettlementVolumes.values()]).toEqual(stored);
  });

  test("loads snapshots written before native market volume was introduced", () => {
    const path = join(mkdtempSync(join(tmpdir(), "pnlx-volume-legacy-")), "protocol-store.json");
    const store = new FileProtocolStore(path);
    const proof = proofMeta();
    store.recordProof(proof);
    store.addSettlement(settlement(proof));

    const snapshot = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    delete snapshot.marketSettlementVolumes;
    writeFileSync(path, JSON.stringify(snapshot));

    const reloaded = new FileProtocolStore(path);
    expect(reloaded.settlements.size).toBe(1);
    expect(reloaded.marketSettlementVolumes.size).toBe(0);
  });

  test("backfills recent settlement volume from retained execution runs", () => {
    const path = join(mkdtempSync(join(tmpdir(), "pnlx-volume-backfill-")), "protocol-store.json");
    const store = new FileProtocolStore(path);
    const completedAt = Date.parse("2026-08-13T12:14:00.000Z");
    store.addBatchExecutionRun({
      aggregateVolume: 42_000_000n,
      batchId: "batch-backfill",
      completedAt,
      fillCount: 2,
      marketId: "xlm-usd-perp",
      runId: "0xrun" as Hex,
      settlementDigest: "0xlegacy-settlement" as Hex,
      startedAt: completedAt - 1_000,
      status: "settled",
    });

    const snapshot = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    delete snapshot.marketSettlementVolumes;
    writeFileSync(path, JSON.stringify(snapshot));

    const reloaded = new FileProtocolStore(path);
    expect([...reloaded.marketSettlementVolumes.values()]).toEqual([{
      marketId: "xlm-usd-perp",
      matchedVolume: 21_000_000n,
      settledAt: completedAt,
      settlementDigest: "0xlegacy-settlement",
    }]);
  });

  test("returns PNLX settlement volume in the requested candle buckets", async () => {
    const store = new ProtocolStore();
    store.marketSettlementVolumes.set("0xone", {
      marketId: "xlm-usd-perp",
      matchedVolume: 7_500_000n,
      settledAt: Date.parse("2026-08-13T12:01:00.000Z"),
      settlementDigest: "0xone",
    });
    store.marketSettlementVolumes.set("0xtwo", {
      marketId: "xlm-usd-perp",
      matchedVolume: 12_500_000n,
      settledAt: Date.parse("2026-08-13T12:14:59.000Z"),
      settlementDigest: "0xtwo",
    });
    store.marketSettlementVolumes.set("0xthree", {
      marketId: "xlm-usd-perp",
      matchedVolume: 35_000_000n,
      settledAt: Date.parse("2026-08-13T12:16:00.000Z"),
      settlementDigest: "0xthree",
    });
    store.marketSettlementVolumes.set("0xother", {
      marketId: "btc-usd-perp",
      matchedVolume: 99_000_000n,
      settledAt: Date.parse("2026-08-13T12:02:00.000Z"),
      settlementDigest: "0xother",
    });
    const marketData = {
      async candles() {
        return {
          cached: false,
          candles: [
            candle("2026-08-13T12:00:00.000Z", 900),
            candle("2026-08-13T12:15:00.000Z", 800),
          ],
          fetchedAt: 1,
          from: 1,
          hasMore: false,
          interval: "15m" as const,
          marketId: "xlm-usd-perp",
          productId: "Crypto.XLM/USD",
          realtime: true,
          source: "pyth-benchmarks",
          stale: false,
          to: 2,
        };
      },
    };
    const service = new MarketsService(
      new ExecutorService({}, store),
      {} as never,
      loadEnv(),
      undefined,
      marketData as never,
    );

    const response = await service.candles({
      interval: "15m",
      limit: 2,
      marketId: "xlm-usd-perp",
    });

    expect(response.source).toBe("pyth-benchmarks");
    expect(response.volumeSource).toBe("pnlx-settlements");
    expect(response.candles.map((item) => item.volume)).toEqual([2, 3.5]);
    expect(JSON.stringify(response)).not.toContain("settlementDigest");
    expect(JSON.stringify(response)).not.toContain("nullifier");
  });
});

function candle(time: string, volume: number) {
  return {
    close: 0.16,
    high: 0.17,
    low: 0.15,
    open: 0.155,
    time,
    volume,
  };
}

function settlement(proof: ProofMeta): BatchSettlement {
  return {
    aggregateVolume: 30_000_000n,
    batchId: "batch-volume",
    fillCount: 2,
    marginChangeCommitments: [],
    marketId: "xlm-usd-perp",
    matchTranscriptDigest: "0xtranscript",
    newCommitments: ["0xposition-one", "0xposition-two"],
    openInterestDelta: 0n,
    orderUpdates: [],
    proof,
    residualSize: 0n,
    settlementDigest: "0xsettlement",
    spentNullifiers: [],
  };
}

function proofMeta(): ProofMeta {
  return {
    circuitHash: "0xcircuit-hash",
    circuitId: "batch-match",
    circuitKey: "0xcircuit-key",
    proofDigest: "0xproof",
    publicInputHash: "0xpublic-input",
    verifierHash: "0xverifier",
  };
}
