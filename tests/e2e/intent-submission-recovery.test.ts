import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { circuitMatchingPayloadCommitment, commitIntent, digestToFieldHex, intentBindingFields, secureMarginRoot } from "@pnlx/crypto";
import type { Hex, IntentRecord, IntentValidityRecord, TradeIntent } from "@pnlx/protocol-types";
import { IntentsService } from "@/features/intents/intents.service";
import { OrdersService } from "@/features/orders/orders.service";
import { FileProtocolStore } from "@/shared/state/persistent-store";
import { applyProtocolStoreSnapshot, snapshotProtocolStore } from "@/shared/state/protocol-snapshot";
import { ProtocolStore } from "@/shared/state/store";
import { NORMALIZED_SNAPSHOT_FIELDS, normalizedSnapshotCounts, normalizedSnapshotFromRecords, normalizedSnapshotRecords } from "@/shared/mongo/snapshot";
import { ExecutorService } from "@/workers/executor/executor.service";
import { IndexerService } from "@/workers/indexer/indexer.service";
import { OnchainRelayService } from "@/workers/onchain/onchain.service";

const key = (label: string) => digestToFieldHex(`intent-recovery:${label}`);
const dirs: string[] = [];
const env = { intentRegistryOnchainRequired: true };
const prover = { assertBoundProof() {} };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true }); });

describe("prepared intent write-ahead recovery", () => {
  test("an accepted intent survives a restart and changed note root with its exact private seed", async () => {
    const path = statePath();
    const store = new FileProtocolStore(path);
    store.addMarginCommitment(key("source-note"));
    const executor = new ExecutorService({}, store);
    const input = fixture(store);
    let registered = false;
    let submissions = 0;
    const onchain = chain(store, input, {
      registered: () => registered,
      submit: (record) => {
        submissions++;
        const durable = new FileProtocolStore(path).pendingIntentSubmissions.get(record.intentCommitment)!;
        expect(durable.prepared.privateMatchIntent.positionSeed).toBe(input.validity.positionSeed);
        expect(durable.prepared.record).toEqual(record);
        expect(new FileProtocolStore(path).delegatedPolicies.get(record.intentCommitment)?.stopLossPrice).toBe("80");
        registered = true;
        throw new Error("registry response was lost");
      },
    });
    store.restoreConfirmedIntent = () => { throw new Error("process stopped before local activation"); };
    await expect(new IntentsService(executor, prover as never, onchain as never, env)
      .submitDurable(input, input.intent.owner)).rejects.toThrow("process stopped");
    expect(store.intents.size).toBe(0);
    const restarted = new FileProtocolStore(path);
    restarted.addMarginCommitment(key("new-independent-deposit"));
    expect(restarted.marginMembershipRoot()).not.toBe(input.validity.marginRoot);
    const service = new IntentsService(new ExecutorService({}, restarted), prover as never,
      chain(restarted, input, { registered: () => true, submit: () => { throw new Error("must not resubmit"); } }) as never, env);
    expect(await service.recoverPendingIntents()).toEqual({ recovered: 1, pending: 0 });
    expect(submissions).toBe(1);
    const persisted = new FileProtocolStore(path);
    expect(persisted.intents.get(input.validity.intentCommitment)?.marginRoot).toBe(input.validity.marginRoot);
    expect(persisted.intents.get(input.validity.intentCommitment)?.submissionSequence).toBe(7n);
    expect(persisted.privateMatchIntents.get(input.validity.intentCommitment)?.positionSeed).toBe(input.validity.positionSeed);
    expect(persisted.orderLifecycle.get(input.validity.intentCommitment)?.status).toBe("open");
    expect(persisted.pendingIntentSubmissions.size).toBe(0);
    const publicView = JSON.stringify(new IndexerService(persisted).snapshot());
    expect(publicView).not.toContain(input.validity.positionSeed);
    expect(publicView).not.toContain("private-stop-salt");
  });

  test("unregistered restart recovery never sends an order and exact retries preserve the prepared witness", async () => {
    const store = new FileProtocolStore(statePath());
    store.addMarginCommitment(key("source-note"));
    const input = fixture(store);
    let submissions = 0;
    const onchain = chain(store, input, { registered: () => false, submit: () => { submissions++; throw new Error("RPC offline"); } });
    const service = new IntentsService(new ExecutorService({}, store), prover as never, onchain as never, env);
    await expect(service.submitDurable(input, input.intent.owner)).rejects.toThrow("RPC offline");
    expect(await service.recoverPendingIntents()).toEqual({ recovered: 0, pending: 1 });
    expect(submissions).toBe(1);
    const original = structuredClone(store.pendingIntentSubmissions.get(input.validity.intentCommitment));
    store.addMarginCommitment(key("another-deposit"));
    await expect(service.submitDurable(input, input.intent.owner)).rejects.toThrow("RPC offline");
    expect(store.pendingIntentSubmissions.get(input.validity.intentCommitment)).toEqual(original);
    await expect(service.submitDurable({ ...input, conditionalPolicy: { stopLossPrice: "70", stopLossSalt: "private-stop-salt" } },
      input.intent.owner)).rejects.toThrow("conflicting prepared intent");
    expect(submissions).toBe(2);
  });

  test("submits a retained historical root only when the note nullifier is still unspent", async () => {
    const store = new ProtocolStore();
    store.addMarginCommitment(key("source-note"));
    const input = fixture(store);
    const historicalRoot = input.validity.marginRoot;
    store.addMarginCommitment(key("newer-note"));
    let registered = false;
    let submissions = 0;
    const onchain = {
      ...chain(store, input, { registered: () => registered, submit: () => { submissions++; registered = true; } }),
      isSecureNoteRootKnownAsync: async (root: Hex) => root === historicalRoot,
      isSecureNullifierSpentAsync: async () => false,
    };
    const result = await new IntentsService(new ExecutorService({}, store), prover as never, onchain as never, env)
      .submitDurable(input, input.intent.owner);
    expect(result.marginRoot).toBe(historicalRoot);
    expect(submissions).toBe(1);

    for (const state of ["unknown-root", "spent-note"] as const) {
      const nextStore = new ProtocolStore();
      nextStore.addMarginCommitment(key("source-note"));
      const nextInput = fixture(nextStore, state);
      nextStore.addMarginCommitment(key("newer-note"));
      let relays = 0;
      const nextOnchain = {
        ...chain(nextStore, nextInput, { registered: () => false, submit: () => { relays++; } }),
        isSecureNoteRootKnownAsync: async () => state !== "unknown-root",
        isSecureNullifierSpentAsync: async () => state === "spent-note",
      };
      const nextService = new IntentsService(new ExecutorService({}, nextStore), prover as never, nextOnchain as never, env);
      await expect(nextService.submitDurable(nextInput, nextInput.intent.owner)).rejects.toThrow(
        state === "unknown-root" ? "intent margin root is not current" : "intent note nullifier is already spent",
      );
      expect(nextStore.pendingIntentSubmissions.size).toBe(0);
      expect(relays).toBe(0);
    }
  });

  test("mismatching registry payloads and inactive accepted intents cannot activate local orders", async () => {
    for (const mismatch of [true, false]) {
      const store = new ProtocolStore();
      store.addMarginCommitment(key("source-note"));
      const input = fixture(store);
      const executor = new ExecutorService({}, store);
      executor.store.recordProof(input.validity.proof);
      store.addPendingIntentSubmission({ intentCommitment: input.validity.intentCommitment, createdAt: 1,
        intent: input.intent, validity: input.validity, prepared: executor.prepareIntent(input) });
      const onchain = { ...chain(store, input, { registered: () => true, submit: () => {} }),
        intentMatchingPayloadCommitmentAsync: async () => mismatch ? key("wrong-payload") : input.validity.matchingPayloadCommitment,
        isIntentActiveAsync: async () => false };
      await expect(new IntentsService(executor, prover as never, onchain as never, env).recoverPendingIntents())
        .rejects.toThrow(mismatch ? "matching payload mismatch" : "settlement reconciliation");
      expect(store.intents.size).toBe(0);
      expect(store.privateMatchIntents.size).toBe(0);
      expect(store.pendingIntentSubmissions.size).toBe(1);
    }
  });

  test("failed durable flush prevents financial relay and failed post-commit flush retains recovery journal", async () => {
    class FailingStore extends ProtocolStore {
      calls = 0;
      failAt = 1;
      async flush() { if (++this.calls === this.failAt) throw new Error("disk unavailable"); }
    }
    const store = new FailingStore();
    store.addMarginCommitment(key("source-note"));
    const input = fixture(store);
    let submissions = 0;
    let registered = false;
    const onchain = chain(store, input, { registered: () => registered, submit: () => { submissions++; registered = true; } });
    const service = new IntentsService(new ExecutorService({}, store), prover as never, onchain as never, env);
    await expect(service.submitDurable(input)).rejects.toThrow("disk unavailable");
    expect(submissions).toBe(0);
    store.failAt = store.calls + 3;
    await expect(service.submitDurable(input)).rejects.toThrow("disk unavailable");
    expect(submissions).toBe(1);
    expect(store.intents.size).toBe(1);
    expect(store.pendingIntentSubmissions.size).toBe(1);
    store.failAt = -1;
    await service.recoverPendingIntents();
    expect(submissions).toBe(1);
    expect(store.pendingIntentSubmissions.size).toBe(0);
  });

  test("replacement journals before cancellation and persists cancellation before registry submission", async () => {
    const path = statePath();
    const store = new FileProtocolStore(path);
    store.addMarginCommitment(key("source-note"));
    const oldInput = fixture(store, "old");
    const executor = new ExecutorService({}, store);
    store.recordProof(oldInput.validity.proof);
    const old = executor.submitIntent(oldInput);
    const replacement = fixture(store, "new", old.noteNullifier);
    let oldActive = true;
    let newRegistered = false;
    let relays = 0;
    const onchain = {
      ...chain(store, replacement, { registered: () => newRegistered, submit: (record) => {
        relays++;
        expect(new FileProtocolStore(path).orderLifecycle.get(old.intentCommitment)?.status).toBe("cancelled");
        expect(new FileProtocolStore(path).pendingIntentSubmissions.get(record.intentCommitment)?.replacementOf).toBe(old.intentCommitment);
        newRegistered = true;
      } }),
      isIntentActiveAsync: async (commitment: Hex) => commitment === old.intentCommitment ? oldActive : true,
      isSecureNullifierSpentAsync: async () => false,
      isIntentCancelledAsync: async () => !oldActive,
      async cancelIntentAsync() {
        expect(new FileProtocolStore(path).pendingIntentSubmissions.size).toBe(1);
        oldActive = false;
        throw new Error("cancel response was lost");
      },
    };
    const orders = new OrdersService(executor, prover as never, onchain as never, env);
    const result = await orders.replaceDurable({ intentCommitment: old.intentCommitment, replacement }, oldInput.intent.owner);
    expect(result.cancelledOrder.status).toBe("cancelled");
    expect(result.replacementIntent.intentCommitment).toBe(replacement.validity.intentCommitment);
    expect(relays).toBe(1);
    expect(new FileProtocolStore(path).pendingIntentSubmissions.size).toBe(0);
  });

  test("prepared records round trip normalized Mongo checkpoints and absent older fields preserve notes", async () => {
    const store = new ProtocolStore();
    store.addMarginCommitment(key("source-note"));
    const input = fixture(store);
    const executor = new ExecutorService({}, store);
    const service = new IntentsService(executor, prover as never,
      chain(store, input, { registered: () => false, submit: () => { throw new Error("offline"); } }) as never, env);
    await expect(service.submitDurable(input)).rejects.toThrow("offline");
    const snapshot = snapshotProtocolStore(store);
    const records = Object.fromEntries(NORMALIZED_SNAPSHOT_FIELDS.map(([field]) => [field,
      normalizedSnapshotRecords("test", "journal", 1, field, snapshot[field]) ]));
    const restored = new ProtocolStore();
    applyProtocolStoreSnapshot(restored, normalizedSnapshotFromRecords(records, normalizedSnapshotCounts(snapshot)));
    expect(restored.pendingIntentSubmissions.get(input.validity.intentCommitment)).toEqual(store.pendingIntentSubmissions.get(input.validity.intentCommitment));
    const oldSnapshot = snapshotProtocolStore(new ProtocolStore());
    oldSnapshot.marginCommitments = [key("preserved-note")];
    delete oldSnapshot.pendingIntentSubmissions;
    const path = statePath();
    writeFileSync(path, JSON.stringify(oldSnapshot));
    expect(new FileProtocolStore(path).pendingIntentSubmissions.size).toBe(0);
    expect([...new FileProtocolStore(path).marginCommitments]).toEqual(oldSnapshot.marginCommitments);
    const counts = normalizedSnapshotCounts(oldSnapshot);
    delete (counts as Partial<typeof counts>).pendingIntentSubmissions;
    const oldRecords = Object.fromEntries(NORMALIZED_SNAPSHOT_FIELDS.map(([field]) => [field,
      normalizedSnapshotRecords("test", "old", 1, field, oldSnapshot[field]) ]));
    expect(normalizedSnapshotFromRecords(oldRecords, counts).pendingIntentSubmissions).toEqual([]);
    expect(readFileSync(path, "utf8")).not.toContain(input.validity.positionSeed);
  });

  test("registry status reads reject ambiguous true substrings", async () => {
    let output = "not true";
    const relayer = { read: () => ({ output }), readAsync: async () => ({ output }) };
    const onchain = new OnchainRelayService(relayer as never, { enabled: true,
      deployment: { contracts: { "intent-registry": "registry" } } } as never);
    expect(() => onchain.isIntentRegistered(key("intent"))).toThrow("invalid intent registration status");
    await expect(onchain.isIntentRegisteredAsync(key("intent"))).rejects.toThrow("invalid intent registration status");
    output = "false";
    expect(onchain.isIntentRegistered(key("intent"))).toBe(false);
    output = '"true"';
    expect(await onchain.isIntentRegisteredAsync(key("intent"))).toBe(true);
  });
});

function statePath() { const dir = mkdtempSync(join(tmpdir(), "pnlx-intent-journal-")); dirs.push(dir); return join(dir, "state.json"); }

function fixture(store: ProtocolStore, suffix = "single", nullifier = key("source-nullifier")) {
  const intent: TradeIntent = { batchId: "batch", marketId: "xlm-usd-perp", owner: "GOWNER", side: "long",
    size: 1n, margin: 100n, limitPrice: 100n, nonce: `nonce-${suffix}`, salt: `salt-${suffix}`, noteNullifier: nullifier };
  const binding = intentBindingFields(intent);
  const validity: IntentValidityRecord = { ...binding, intentCommitment: commitIntent(intent), noteNullifier: nullifier,
    assetDigest: key("asset"), ownerDigest: key("owner"), positionSeed: key(`private-seed-${suffix}`),
    matchingPayloadCommitment: "0x0", marginRoot: store.marginMembershipRoot(), noteChangeCommitment: "0x0",
    noteCommitment: key("source-note"), currentBatch: 1n, expiryBatch: 2n,
    proof: { circuitId: "intent-validity", circuitKey: key("circuit"), circuitHash: key("source"), verifierHash: key("vk"),
      proofDigest: key(`proof-${suffix}`), publicInputHash: key(`public-${suffix}`) } };
  validity.matchingPayloadCommitment = circuitMatchingPayloadCommitment({ intentCommitment: validity.intentCommitment,
    marketDigest: binding.marketDigest, ownerDigest: validity.ownerDigest, positionSeed: validity.positionSeed,
    signedSize: intent.size, limitPrice: intent.limitPrice, margin: intent.margin, noteNullifier: nullifier, noteChangeCommitment: "0x0" });
  return { intent, validity, conditionalPolicy: { stopLossPrice: "80", stopLossSalt: "private-stop-salt" } };
}

function chain(_store: ProtocolStore, input: ReturnType<typeof fixture>, state: {
  registered: () => boolean; submit: (record: IntentRecord) => void;
}) {
  return { enabled: true, secureNoteSnapshot: (commitments: Hex[]) => ({ commitments, root: secureMarginRoot(commitments) }),
    isSecureNoteRootKnownAsync: async () => true, isSecureNullifierSpentAsync: async () => false,
    isIntentRegisteredAsync: async () => state.registered(),
    intentMatchingPayloadCommitmentAsync: async () => input.validity.matchingPayloadCommitment,
    isIntentActiveAsync: async () => true,
    intentSubmissionSequenceAsync: async () => 7n,
    submitIntentAsync: async (record: IntentRecord) => {
      state.submit(record);
      return { relays: [{ functionName: "submit", submitted: true, txHash: key("accepted-tx") }] };
    } };
}
