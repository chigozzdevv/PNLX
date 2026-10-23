import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hex, ResidualOrderRecord } from "@pnlx/protocol-types";
import {
  createDelegatedConditionalPolicy,
  deriveDelegatedConditionalSalt,
  findDelegatedConditionalPolicy,
} from "@/shared/protocol/delegated-policies";
import { FileProtocolStore } from "@/shared/state/persistent-store";
import { applyProtocolStoreSnapshot, snapshotProtocolStore } from "@/shared/state/protocol-snapshot";
import { ProtocolStore } from "@/shared/state/store";
import { NORMALIZED_SNAPSHOT_FIELDS, normalizedSnapshotCounts, normalizedSnapshotFromRecords, normalizedSnapshotRecords } from "@/shared/mongo/snapshot";
import type { PendingPairedClose } from "@/shared/protocol/paired-close-journal";
import { createIndexer } from "@/workers/indexer/indexer.worker";

const scope = { createdAt: 1, intentCommitment: "0xAA" as Hex, marketId: "xlm-usd-perp", ownerCommitment: "0xBB" as Hex };
const input = { stopLossPrice: "000100", stopLossSalt: "secret-stop", takeProfitPrice: "200", takeProfitSalt: "secret-profit" };
const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { force: true, recursive: true }); });

describe("intent-bound delegated conditional policies", () => {
  test("canonicalizes only full reduce-only triggers and rejects broader authority", () => {
    expect(createDelegatedConditionalPolicy(undefined, scope)).toBeUndefined();
    expect(createDelegatedConditionalPolicy(input, scope)).toEqual({
      ...input, ...scope, intentCommitment: "0xaa", ownerCommitment: "0xbb", stopLossPrice: "100", reduceOnly: true,
    });
    for (const invalid of [
      { ...input, reduceOnly: false }, { ...input, withdrawRecipient: "attacker" },
      { stopLossPrice: "0", stopLossSalt: "s" }, { stopLossPrice: "1" }, { stopLossSalt: "s" },
      { stopLossPrice: (1n << 128n).toString(), stopLossSalt: "s" }, {},
    ]) expect(() => createDelegatedConditionalPolicy(invalid, scope)).toThrow();
  });

  test("identical retries retain first timestamp and conflicting retries do not change authority", () => {
    const store = new ProtocolStore();
    store.addDelegatedConditionalPolicy(createDelegatedConditionalPolicy(input, scope)!);
    store.addDelegatedConditionalPolicy(createDelegatedConditionalPolicy(input, { ...scope, createdAt: 2 })!);
    expect(store.delegatedPolicies.size).toBe(1);
    expect(store.delegatedPolicies.get("0xaa")!.createdAt).toBe(1);
    expect(() => store.addDelegatedConditionalPolicy(createDelegatedConditionalPolicy({ ...input, stopLossPrice: "101" }, scope)!)).toThrow("conflicting");
    expect(store.delegatedPolicies.get("0xaa")!.stopLossPrice).toBe("100");
  });

  test("residual chains inherit only same-owner same-market source authority", () => {
    const store = new ProtocolStore();
    const policy = createDelegatedConditionalPolicy(input, scope)!;
    store.addDelegatedConditionalPolicy(policy);
    store.residualOrders.set("0xcc", residual("0xcc", "0xaa"));
    store.residualOrders.set("0xdd", residual("0xdd", "0xcc"));
    expect(findDelegatedConditionalPolicy(store, "0xDD")).toEqual(policy);
    store.residualOrders.set("0xcc", { ...residual("0xcc", "0xaa"), ownerCommitment: "0x01" });
    expect(() => findDelegatedConditionalPolicy(store, "0xdd")).toThrow("scope mismatch");
    store.residualOrders.set("0xcc", residual("0xcc", "0xdd"));
    expect(() => findDelegatedConditionalPolicy(store, "0xdd")).toThrow("cyclic");
  });

  test("derives the same per-position salt as the browser", () => {
    expect(deriveDelegatedConditionalSalt("base-secret", "0xAB", "0xCD")).toBe("base-secret:0xab:0xcd");
    expect(deriveDelegatedConditionalSalt("base-secret", "0xAC", "0xCD")).not.toBe("base-secret:0xab:0xcd");
  });

  test("persists policies in file and normalized Mongo checkpoints", () => {
    const directory = mkdtempSync(join(tmpdir(), "pnlx-policy-"));
    directories.push(directory);
    const path = join(directory, "state.json");
    const store = new FileProtocolStore(path);
    const policy = createDelegatedConditionalPolicy(input, scope)!;
    store.addDelegatedConditionalPolicy(policy);
    expect(new FileProtocolStore(path).delegatedPolicies.get("0xaa")).toEqual(policy);
    const snapshot = snapshotProtocolStore(store);
    const records = Object.fromEntries(NORMALIZED_SNAPSHOT_FIELDS.map(([field]) => [field,
      normalizedSnapshotRecords("test", "snapshot", 1, field, snapshot[field]),
    ]));
    const restored = new ProtocolStore();
    applyProtocolStoreSnapshot(restored, normalizedSnapshotFromRecords(records, normalizedSnapshotCounts(snapshot)));
    expect(restored.delegatedPolicies.get("0xaa")).toEqual(policy);
  });

  test("old file and normalized checkpoints retain notes and default policies empty", () => {
    const directory = mkdtempSync(join(tmpdir(), "pnlx-policy-old-"));
    directories.push(directory);
    const path = join(directory, "state.json");
    const store = new ProtocolStore();
    store.marginCommitments.add("0x123");
    const snapshot = snapshotProtocolStore(store);
    delete snapshot.delegatedPolicies;
    delete snapshot.pendingPairedCloses;
    writeFileSync(path, JSON.stringify(snapshot));
    const restored = new FileProtocolStore(path);
    expect([...restored.marginCommitments]).toEqual(["0x123"]);
    expect(restored.delegatedPolicies.size).toBe(0);
    const counts = normalizedSnapshotCounts(snapshot);
    delete (counts as Partial<typeof counts>).delegatedPolicies;
    delete (counts as Partial<typeof counts>).pendingPairedCloses;
    const records = { marginCommitments: normalizedSnapshotRecords("test", "old", 1, "marginCommitments", ["0x123"]) };
    expect(normalizedSnapshotFromRecords(records, counts).delegatedPolicies).toEqual([]);
    expect(normalizedSnapshotFromRecords(records, counts).pendingPairedCloses).toEqual([]);
    expect(normalizedSnapshotFromRecords(records, counts).marginCommitments).toEqual(["0x123"]);
  });

  test("keeps complete paired close recovery material durable until explicit removal", () => {
    const directory = mkdtempSync(join(tmpdir(), "pnlx-pair-journal-"));
    directories.push(directory);
    const path = join(directory, "state.json");
    const store = new FileProtocolStore(path);
    const record = { journalKey: "0x123", createdAt: 1, conditional: true,
      pair: { positions: [{ closeCommitment: "0x123" }, { closeCommitment: "0x456" }], currentFundingIndex: -123n },
      outputNotes: [{ spendSecretDigest: "private-a", amount: "10" }, { spendSecretDigest: "private-b", amount: "20" }],
    } as unknown as PendingPairedClose;
    store.addPendingPairedClose(record);
    store.addPendingPairedClose({ ...record, createdAt: 2 });
    expect(() => store.addPendingPairedClose({ ...record, conditional: false })).toThrow("conflicting");
    expect(new FileProtocolStore(path).pendingPairedCloses.get("0x123")).toEqual(record);
    const snapshot = snapshotProtocolStore(store);
    const records = Object.fromEntries(NORMALIZED_SNAPSHOT_FIELDS.map(([field]) => [field,
      normalizedSnapshotRecords("test", "pair", 1, field, snapshot[field]),
    ]));
    const restored = new ProtocolStore();
    applyProtocolStoreSnapshot(restored, normalizedSnapshotFromRecords(records, normalizedSnapshotCounts(snapshot)));
    expect(restored.pendingPairedCloses.get("0x123")).toEqual(record);
    const publicView = JSON.stringify(createIndexer(restored).snapshot());
    expect(publicView).not.toContain("private-a");
    expect(publicView).not.toContain("private-b");
    expect(publicView).not.toContain("pendingPairedCloses");
    store.removePendingPairedClose("0x123");
    expect(new FileProtocolStore(path).pendingPairedCloses.size).toBe(0);
  });
});

function residual(intentCommitment: Hex, sourceIntentCommitment: Hex): ResidualOrderRecord {
  return { batchId: "batch", createdAt: 1, intentCommitment, marketId: scope.marketId, matchingPayloadCommitment: "0x01",
    noteNullifier: "0x02", ownerCommitment: "0xbb", sourceIntentCommitment, updatedAt: 1 };
}
