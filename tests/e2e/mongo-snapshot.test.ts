import { describe, expect, test } from "bun:test";
import { hashFields } from "@pnlx/crypto";
import { PRICE_SCALE } from "@pnlx/market-math";
import {
  NORMALIZED_PROTOCOL_FORMAT,
  NORMALIZED_SNAPSHOT_FIELDS,
  commitProtocolCheckpoint,
  normalizedSnapshotCounts,
  normalizedSnapshotFromRecords,
  normalizedSnapshotPositionRoot,
  normalizedSnapshotRecords,
  protocolCheckpointFilter,
  type NormalizedSnapshotField,
  type NormalizedSnapshotRecord,
} from "@/shared/mongo/snapshot";
import {
  snapshotProtocolStore,
} from "@/shared/state/protocol-snapshot";
import { ProtocolStore } from "@/shared/state/store";

describe("normalized Mongo protocol snapshots", () => {
  test("round-trips every protocol snapshot field without losing bigint values or order", () => {
    const store = new ProtocolStore();
    store.addMarket({
      fundingIndex: 7n,
      initialMarginRate: 100_000n,
      maintenanceMarginRate: 50_000n,
      marketId: "xlm-usd-perp",
      maxLeverage: 10n,
      oraclePrice: 2n * PRICE_SCALE,
    });
    store.addMarginCommitment(hashFields("margin", ["one"]));
    store.positionCommitments.add(hashFields("position", ["one"]));
    store.positionCommitments.add(hashFields("position", ["two"]));
    store.spend(hashFields("nullifier", ["one"]));
    const snapshot = snapshotProtocolStore(store);
    const snapshotId = "snapshot-roundtrip";
    const records = Object.fromEntries(
      NORMALIZED_SNAPSHOT_FIELDS.map(([field]) => [
        field,
        normalizedSnapshotRecords("testnet", snapshotId, 3, field, snapshot[field]),
      ]),
    ) as Record<NormalizedSnapshotField, NormalizedSnapshotRecord[]>;

    const restored = normalizedSnapshotFromRecords(
      records,
      normalizedSnapshotCounts(snapshot),
    );

    expect(restored).toEqual(snapshot);
    expect(normalizedSnapshotPositionRoot(restored)).toBe(store.positionMembershipRoot());
    expect(Object.keys(records).sort()).toEqual(
      Object.keys(snapshot).sort(),
    );
  });

  test("rejects incomplete normalized snapshots", () => {
    const snapshot = snapshotProtocolStore(new ProtocolStore());
    const counts = normalizedSnapshotCounts(snapshot);
    counts.positionCommitments = 1;

    expect(() => normalizedSnapshotFromRecords({}, counts)).toThrow(
      "count mismatch for positionCommitments",
    );
  });

  test("restores a pre-funding-journal checkpoint without dropping existing state or proofs", () => {
    const store = new ProtocolStore();
    store.addMarket({ marketId: "xlm-usd-perp", oraclePrice: 20_000_000n, fundingIndex: -7n,
      initialMarginRate: 100_000n, maintenanceMarginRate: 50_000n, maxLeverage: 10n });
    store.addMarginCommitment(hashFields("legacy-margin", [1]));
    store.positionCommitments.add(hashFields("legacy-position", [1]));
    store.spend(hashFields("legacy-nullifier", [1]));
    store.recordProof({ circuitId: "batch-match", circuitKey: hashFields("circuit-key", [1]),
      circuitHash: hashFields("circuit-hash", [1]), verifierHash: hashFields("verifier", [1]),
      publicInputHash: hashFields("public-input", [1]), proofDigest: hashFields("proof", [1]) });
    store.addFundingUpdate({ marketId: "xlm-usd-perp", appliedAt: 3_600_000, oldFundingIndex: 0n,
      newFundingIndex: -7n, fundingDelta: -7n, premiumRate: -1_000n });
    const snapshot = snapshotProtocolStore(store);
    const counts: Partial<ReturnType<typeof normalizedSnapshotCounts>> = normalizedSnapshotCounts(snapshot);
    delete counts.fundingCycles;
    delete counts.fundingCursors;
    const records = Object.fromEntries(NORMALIZED_SNAPSHOT_FIELDS
      .filter(([field]) => field !== "fundingCycles" && field !== "fundingCursors")
      .map(([field]) => [field, normalizedSnapshotRecords("testnet", "legacy-funding", 76, field, snapshot[field])])) as
      Partial<Record<NormalizedSnapshotField, NormalizedSnapshotRecord[]>>;

    const restored = normalizedSnapshotFromRecords(records, counts);

    expect(restored).toEqual(snapshot);
    for (const [field] of NORMALIZED_SNAPSHOT_FIELDS) expect(restored[field]).toEqual(snapshot[field]);
    expect(restored.proofs).toHaveLength(1);
    expect(restored.markets[0][1].fundingIndex).toBe(-7n);
    expect(normalizedSnapshotPositionRoot(restored)).toBe(store.positionMembershipRoot());
    expect(restored.fundingCycles).toEqual([]);
    expect(restored.fundingCursors).toEqual([]);
  });

  test("funding journal rows require declared counts even when older checkpoints may omit empty fields", () => {
    const store = new ProtocolStore();
    store.skipFundingCycle({ cycleId: `0x${"1".padStart(64, "0")}`, marketId: "xlm-usd-perp",
      windowStart: 0, windowEnd: 3_600_000, intervalMs: 3_600_000, markPrice: 20_000_000n,
      oldFundingIndex: -7n, newFundingIndex: -7n, premiumRate: null, status: "skipped",
      reason: "insufficient two-sided impact depth", updatedAt: 3_600_001 });
    const snapshot = snapshotProtocolStore(store);
    const counts = normalizedSnapshotCounts(snapshot);
    const records = Object.fromEntries(NORMALIZED_SNAPSHOT_FIELDS.map(([field]) =>
      [field, normalizedSnapshotRecords("testnet", "funding-journal", 77, field, snapshot[field])])) as
      Record<NormalizedSnapshotField, NormalizedSnapshotRecord[]>;
    expect(normalizedSnapshotFromRecords(records, counts)).toEqual(snapshot);

    for (const field of ["fundingCycles", "fundingCursors"] as const) {
      const legacyCounts: Partial<typeof counts> = { ...counts };
      delete legacyCounts[field];
      expect(() => normalizedSnapshotFromRecords(records, legacyCounts)).toThrow(`count mismatch for ${field}: expected 0, received 1`);
    }
  });

  test("treats funding premium samples as empty when loading a pre-sampler checkpoint", () => {
    const snapshot = snapshotProtocolStore(new ProtocolStore());
    const counts = normalizedSnapshotCounts(snapshot);
    delete (counts as Partial<typeof counts>).fundingPremiumSamples;

    expect(normalizedSnapshotFromRecords({}, {
      ...counts,
      fundingPremiumSamples: 0,
    }).fundingPremiumSamples).toEqual([]);
  });

  test("builds a compare-and-swap filter for the expected checkpoint version", () => {
    expect(protocolCheckpointFilter("testnet", 7)).toEqual({
      _id: "testnet",
      version: 7,
    });
    expect(protocolCheckpointFilter("testnet", 0)).toEqual({
      _id: "testnet",
      $or: [
        { version: 0 },
        { version: { $exists: false } },
      ],
    });
  });

  test("rejects a stale checkpoint writer instead of inserting over an existing document", async () => {
    const calls: string[] = [];
    const collection = {
      async insertOne() {
        calls.push("insert");
        throw Object.assign(new Error("duplicate key"), { code: 11000 });
      },
      async updateOne() {
        calls.push("update");
        return { matchedCount: 0 };
      },
    };
    const committed = await commitProtocolCheckpoint(
      collection as never,
      checkpoint(1),
      0,
    );

    expect(committed).toBe(false);
    expect(calls).toEqual(["update", "insert"]);
  });

  test("commits when the stored checkpoint version matches", async () => {
    let insertCalls = 0;
    const collection = {
      async insertOne() {
        insertCalls += 1;
        return {};
      },
      async updateOne() {
        return { matchedCount: 1 };
      },
    };
    const committed = await commitProtocolCheckpoint(
      collection as never,
      checkpoint(8),
      7,
    );

    expect(committed).toBe(true);
    expect(insertCalls).toBe(0);
  });
});

function checkpoint(version: number) {
  const snapshot = snapshotProtocolStore(new ProtocolStore());
  return {
    _id: "testnet",
    counts: normalizedSnapshotCounts(snapshot),
    format: NORMALIZED_PROTOCOL_FORMAT,
    positionRoot: normalizedSnapshotPositionRoot(snapshot),
    snapshotId: `snapshot-${version}`,
    updatedAt: new Date(0),
    version,
  } as const;
}
