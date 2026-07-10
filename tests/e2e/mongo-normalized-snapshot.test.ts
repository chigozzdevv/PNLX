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
} from "@/shared/state/mongo-normalized-snapshot";
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
