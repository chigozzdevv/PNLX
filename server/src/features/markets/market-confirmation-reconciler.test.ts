import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashFields } from "@pnlx/crypto";
import type { BatchSettlement, Hex } from "@pnlx/protocol-types";
import { loadEnv } from "@/config/env";
import { SUPPORTED_PERP_ASSETS } from "@/config/assets";
import { MarketConfirmationReconciler } from "@/features/markets/market-confirmation-reconciler";
import { marketOpenInterest } from "@/features/markets/market-open-interest";
import { MarketsService } from "@/features/markets/markets.service";
import { withPositionMutation } from "@/shared/protocol/position-mutation";
import { FileProtocolStore } from "@/shared/state/persistent-store";
import { ProtocolStore } from "@/shared/state/store";
import { snapshotProtocolStore } from "@/shared/state/protocol-snapshot";
import { normalizedSnapshotCounts, normalizedSnapshotFromRecords, normalizedSnapshotRecords } from "@/shared/mongo/snapshot";

const MARKET = "xlm-usd-perp", BASE = 10_000_000n, PRICE = 100_000_000n;
const key = (value: string): Hex => hashFields("confirmation-repair-test", [value]);
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function addLegacy(store: ProtocolStore, batchId = "legacy", flag?: boolean, closed = false) {
  const settlement = {
    batchId, marketId: MARKET, settlementDigest: key(batchId), onchainConfirmed: flag,
    aggregateVolume: 6n * BASE, fillCount: 2, newCommitments: [key(`${batchId}-long`), key(`${batchId}-short`)],
    spentNullifiers: [], orderUpdates: [], proof: { proofDigest: key(`${batchId}-proof`) },
  } as unknown as BatchSettlement;
  const mapKey = `${MARKET}:${batchId}`;
  store.settlements.set(mapKey, settlement);
  settlement.newCommitments.forEach((commitment, index) => {
    store.positionCommitments.add(commitment);
    store.positionLifecycle.set(commitment, { batchId, marketId: MARKET, positionCommitment: commitment,
      positionNullifier: key(`${batchId}-nullifier-${index}`), settlementDigest: settlement.settlementDigest,
      sourceIntentCommitment: key(`${batchId}-source-${index}`), ownerCommitment: key(`${batchId}-owner-${index}`),
      openedAt: 1, updatedAt: 1, status: closed ? "closed" : "open" });
  });
  return { settlement, mapKey };
}

describe("historical market confirmation repair", () => {
  test("verifies exact batch/market/digest and repairs closed legacy history without replaying positions or balances", async () => {
    const store = new ProtocolStore();
    const legacy = addLegacy(store, "closed-old", undefined, true);
    addLegacy(store, "current-open", true);
    const before = snapshotProtocolStore(store);
    expect(marketOpenInterest(store, MARKET, PRICE, { requireOnchainConfirmation: true }).baseAmount).toBeNull();
    const calls: unknown[][] = [];
    const result = await new MarketConfirmationReconciler(store, { async isBatchSettledAsync(...args) {
      calls.push(args); return true;
    } }).refresh();
    expect(calls).toEqual([[legacy.settlement.batchId, MARKET, legacy.settlement.settlementDigest]]);
    expect(result).toEqual({ checked: 1, confirmed: 1, errors: 0 });
    expect(marketOpenInterest(store, MARKET, PRICE, { requireOnchainConfirmation: true }).baseAmount).toBe(3n * BASE);
    const after = snapshotProtocolStore(store);
    expect({ ...after, settlements: [] }).toEqual({ ...before, settlements: [] });
    expect(store.settlements.get(legacy.mapKey)).toEqual({ ...legacy.settlement, onchainConfirmed: true });
  });

  test("false, malformed truthy responses, RPC errors and missing readers never promote confirmation", async () => {
    for (const answer of [false, "true", "throw", "missing"] as const) {
      const store = new ProtocolStore(); const { mapKey } = addLegacy(store, "unverified", false);
      const reader = answer === "missing" ? undefined : { async isBatchSettledAsync() {
        if (answer === "throw") throw new Error("RPC unavailable");
        return answer as unknown as boolean;
      } };
      const result = await new MarketConfirmationReconciler(store, reader).refresh();
      expect(result.confirmed).toBe(0); expect(store.settlements.get(mapKey)?.onchainConfirmed).toBe(false);
    }
    const store = new ProtocolStore(); addLegacy(store, "already-confirmed", true);
    let reads = 0;
    await new MarketConfirmationReconciler(store, { async isBatchSettledAsync() { reads++; return false; } }).refresh();
    expect(reads).toBe(0);
  });

  test("coalesces concurrent services and preserves transaction metadata updated while verification is in flight", async () => {
    const store = new ProtocolStore(), gate = deferred<boolean>(); const { settlement, mapKey } = addLegacy(store);
    let calls = 0;
    const reader = { isBatchSettledAsync: () => { calls++; return gate.promise; } };
    const a = new MarketConfirmationReconciler(store, reader), b = new MarketConfirmationReconciler(store, reader);
    const first = a.refresh(), second = b.refresh();
    expect(first).toBe(second); await tick(); expect(calls).toBe(1);
    const tx = key("new-settlement-tx");
    store.updateSettlementTransactions(settlement.settlementDigest, { settlementTxHash: tx });
    gate.resolve(true); expect((await first).confirmed).toBe(1);
    expect(store.settlements.get(mapKey)).toMatchObject({ onchainConfirmed: true, settlementTxHash: tx });
  });

  test("rereads immutable identity inside the executor queue and never overwrites a changed record", async () => {
    const store = new ProtocolStore(), gate = deferred<void>(); const { settlement, mapKey } = addLegacy(store);
    const lock = withPositionMutation(store, async () => {
      await gate.promise;
      store.settlements.set(mapKey, { ...settlement, aggregateVolume: 8n * BASE });
    });
    const repair = new MarketConfirmationReconciler(store, { async isBatchSettledAsync() { return true; } }).refresh();
    await tick(); gate.resolve(); await lock;
    expect((await repair).confirmed).toBe(0);
    expect(store.settlements.get(mapKey)).toMatchObject({ aggregateVolume: 8n * BASE });
    expect(store.settlements.get(mapKey)?.onchainConfirmed).toBeUndefined();
  });

  test("deduplicates aliases only for the same exact request identity", async () => {
    const store = new ProtocolStore(); const { settlement } = addLegacy(store);
    store.settlements.set("same-identity-alias", { ...settlement });
    store.settlements.set("other-batch-alias", { ...settlement, batchId: "other-batch" });
    const calls: string[] = [];
    const result = await new MarketConfirmationReconciler(store, { async isBatchSettledAsync(batchId) {
      calls.push(batchId); return batchId === settlement.batchId;
    } }).refresh();
    expect(calls.sort()).toEqual(["legacy", "other-batch"]);
    expect(result.confirmed).toBe(2);
    expect(store.settlements.get("other-batch-alias")?.onchainConfirmed).toBeUndefined();
  });

  test("bounds a cycle to two reads and rotates past failed history with exponential backoff", async () => {
    const store = new ProtocolStore(); for (const label of ["a", "b", "c"]) addLegacy(store, label);
    let now = 1_000; const calls: string[] = [];
    const reconciler = new MarketConfirmationReconciler(store, { async isBatchSettledAsync(batchId) {
      calls.push(batchId); return batchId === "c";
    } }, { now: () => now, scanIntervalMs: 5, retryMs: 100 });
    expect((await reconciler.refresh()).checked).toBe(2); expect(calls).toEqual(["a", "b"]);
    expect((await reconciler.refresh()).checked).toBe(0);
    now += 5; expect((await reconciler.refresh()).confirmed).toBe(1); expect(calls).toEqual(["a", "b", "c"]);
    now += 5; expect((await reconciler.refresh()).checked).toBe(0);
    now += 100; expect((await reconciler.refresh()).checked).toBe(2);
  });

  test("times out without overlapping the underlying stalled read or accepting its late result", async () => {
    const store = new ProtocolStore(), gate = deferred<boolean>(); const { mapKey } = addLegacy(store);
    let calls = 0, now = 1_000;
    const reconciler = new MarketConfirmationReconciler(store, { isBatchSettledAsync() { calls++; return gate.promise; } },
      { now: () => now, timeoutMs: 5, retryMs: 1, scanIntervalMs: 1 });
    expect((await reconciler.refresh()).errors).toBe(1);
    now += 10; expect((await reconciler.refresh()).checked).toBe(0); expect(calls).toBe(1);
    gate.resolve(true); await tick(); expect(store.settlements.get(mapKey)?.onchainConfirmed).toBeUndefined();
  });

  test("uses File persistence and normalized Mongo codecs without replaying financial state", async () => {
    const root = mkdtempSync(join(tmpdir(), "pnlx-confirmation-"));
    try {
      const path = join(root, "state.json"), store = new FileProtocolStore(path); const { mapKey } = addLegacy(store);
      expect((await new MarketConfirmationReconciler(store, { async isBatchSettledAsync() { return true; } }).refresh()).confirmed).toBe(1);
      const restored = new FileProtocolStore(path);
      expect(restored.settlements.get(mapKey)?.onchainConfirmed).toBe(true);
      expect(marketOpenInterest(restored, MARKET, PRICE, { requireOnchainConfirmation: true }).baseAmount).toBe(3n * BASE);
      const snapshot = snapshotProtocolStore(restored), counts = normalizedSnapshotCounts(snapshotProtocolStore(new ProtocolStore()));
      counts.settlements = snapshot.settlements.length;
      const records = normalizedSnapshotRecords("testnet", "confirmed", 1, "settlements", snapshot.settlements);
      expect(normalizedSnapshotFromRecords({ settlements: records }, counts).settlements).toEqual(snapshot.settlements);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("does not report a durable repair when checkpoint flush fails", async () => {
    const store = new ProtocolStore(); addLegacy(store);
    Object.assign(store, { async flush() { throw new Error("checkpoint unavailable"); } });
    const result = await new MarketConfirmationReconciler(store, { async isBatchSettledAsync() { return true; } }).refresh();
    expect(result).toEqual({ checked: 1, confirmed: 0, errors: 1 });
  });

  test("public summaries remain responsive while verification is pending and publish the repaired aggregate on the next read", async () => {
    const store = new ProtocolStore(), gate = deferred<boolean>(); addLegacy(store);
    for (const asset of Object.values(SUPPORTED_PERP_ASSETS)) store.markets.set(asset.marketId, {
      marketId: asset.marketId, fundingIndex: 0n, oraclePrice: PRICE, maxLeverage: asset.maxLeverage,
      initialMarginRate: asset.initialMarginRate, maintenanceMarginRate: asset.maintenanceMarginRate,
    });
    const env = { ...loadEnv({ validateRuntime: false }), marketId: MARKET, settlementsOnchainRequired: true };
    const riskReads: string[] = [];
    const service = new MarketsService({ store } as never, {} as never, env, {
      enabled: true, isBatchSettledAsync: () => gate.promise,
      async marketFundingIndexAsync(marketId: string) { riskReads.push(marketId); return 0n; },
    } as never);
    const first = await service.list();
    expect(first.find((market) => market.marketId === MARKET)?.openInterest).toBeNull();
    gate.resolve(true); await tick();
    const second = await service.list();
    const xlm = second.find((market) => market.marketId === MARKET)!;
    expect(xlm.openInterest).toBe(3n * BASE);
    expect(xlm.riskFunding).toMatchObject({ status: "available", source: "onchain-market", fundingIndex: 0n });
    expect(riskReads).toEqual([MARKET]);
  });
});
