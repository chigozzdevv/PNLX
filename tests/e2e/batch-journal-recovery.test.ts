import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { digestToFieldHex } from "@pnlx/crypto";
import type { BatchSettlement, Hex, PrivateMatchIntent, ProofMeta } from "@pnlx/protocol-types";
import { FileProtocolStore } from "@/shared/state/persistent-store";
import { BatchesService } from "@/features/batches/batches.service";
import { BatchExecutorService } from "@/workers/batch-executor/batch-executor.service";
import { BatchMatcherService } from "@/workers/batch-matcher/batch-matcher.service";
import { IndexerService } from "@/workers/indexer/indexer.service";
import { prepareRisc0SettlementDraft } from "@/workers/risc0-matcher/risc0-proof";
import type { ExternalBatchSettlementTranscript } from "@/workers/executor/executor.model";
import type { CreateExternalSettlementInput } from "@/workers/matcher/matcher.model";

const key = (label: string) => digestToFieldHex(`batch-journal-recovery:${label}`);
const marketId = "xlm-usd-perp";
const proof: ProofMeta = { circuitId: "batch-match", circuitKey: key("circuit-key"), circuitHash: key("source"),
  verifierHash: key("vk"), publicInputHash: key("public"), proofDigest: key("proof") };
const encode = (value: unknown) => JSON.stringify(value, (_name, item) => typeof item === "bigint" ? item.toString() : item);

function seed(store: FileProtocolStore, sides = [1n, -1n]) {
  store.markets.set(marketId, { marketId, fundingIndex: 0n, oraclePrice: 100_000_000n,
    initialMarginRate: 100_000n, maintenanceMarginRate: 50_000n, maxLeverage: 10n });
  for (const [index, side] of sides.entries()) {
    const intent: PrivateMatchIntent = { batchId: "client-order", marketId,
      intentCommitment: key(`intent-${index}`), noteNullifier: key(`note-${index}`),
      ownerCommitment: key(`owner-${index}`), ownerDigest: key(`owner-field-${index}`),
      positionSeed: key(`private-position-seed-${index}`), noteChangeCommitment: "0x0",
      limitPrice: 100_000_000n, margin: 200_000_000n, signedSize: side * 1_000_000_000n };
    store.intents.set(intent.intentCommitment, { ...intent, submissionSequence: BigInt(index) } as never);
    store.privateMatchIntents.set(intent.intentCommitment, intent);
    store.orderLifecycle.set(intent.intentCommitment, { batchId: intent.batchId, marketId,
      intentCommitment: intent.intentCommitment, ownerCommitment: intent.ownerCommitment,
      createdAt: index + 1, updatedAt: index + 1, status: "open" });
  }
}

function transcript(store: FileProtocolStore, input: CreateExternalSettlementInput): ExternalBatchSettlementTranscript {
  const market = store.markets.get(input.marketId)!;
  const intents = input.intentCommitments!.map((id) => ({ ...store.privateMatchIntents.get(id)!, batchId: input.batchId }));
  const match = new BatchMatcherService().match({ batchId: input.batchId, market, intents });
  const settlement = { ...prepareRisc0SettlementDraft({ batchId: input.batchId, market, intents, match }), proof };
  return { settlement, privateMatchIntents: match.residuals, residualOrders: [], accountEvents: [{
    eventId: key("event"), ownerCommitment: intents[0]!.ownerCommitment, ciphertext: "original-private-output-envelope",
  } as never], positionOpenings: match.fills.map((fill) => ({ batchId: input.batchId, marketId,
    fundingIndex: market.fundingIndex, ownerCommitment: fill.ownerCommitment, positionCommitment: fill.positionCommitment,
    positionNullifier: fill.positionNullifier, sourceIntentCommitment: fill.intentCommitment,
    settlementDigest: settlement.settlementDigest, openedAt: 1, updatedAt: 1, status: "open" })) };
}

function executor(store: FileProtocolStore, committed: ExternalBatchSettlementTranscript[]) {
  return { store, validateExternalBatchSettlement(value: ExternalBatchSettlementTranscript) {
    if (value.accountEvents.length === 0) throw new Error("account events required before relay");
    if (value.settlement.newCommitments.length !== value.positionOpenings.length) throw new Error("output count mismatch");
  }, commitExternalBatchSettlement(value: ExternalBatchSettlementTranscript) {
    committed.push(value);
    store.settlements.set(`${value.settlement.marketId}:${value.settlement.batchId}`, value.settlement);
    for (const commitment of value.settlement.newCommitments) store.positionCommitments.add(commitment);
    for (const opening of value.positionOpenings) store.positionLifecycle.set(opening.positionCommitment, opening);
    for (const update of value.settlement.orderUpdates) Object.assign(store.orderLifecycle.get(update.intentCommitment)!, update);
    for (const event of value.accountEvents) store.accountEvents.set(event.eventId, event);
    return value.settlement;
  } };
}

test("an uncertain batch preserves the original proof and outputs across File restart and funding/risk changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "pnlx-batch-journal-"));
  try {
    const path = join(root, "store.json");
    const store = new FileProtocolStore(path); seed(store);
    let original!: ExternalBatchSettlementTranscript;
    let sends = 0;
    let settled = false;
    const committed: ExternalBatchSettlementTranscript[] = [];
    const relay = {
      positionRoot: () => store.positionMembershipRoot(),
      isBatchSettled: (_batch: string, _market: string, digest: Hex) => settled && digest === original.settlement.settlementDigest,
      batchPositionAppendIndexAsync: async () => 0,
      settleBatch(_settlement: BatchSettlement) { sends++; settled = true; throw new Error("response lost after settlement"); },
    };
    const first = await new BatchExecutorService(executor(store, committed) as never, {
      createSettlementTranscript(input) { original = transcript(store, input); return original; },
    }, { intervalMs: 1000, settlementsOnchainRequired: true }, relay as never).runOnce({ now: 100 });
    expect(first.results[0]!.record.status).toBe("failed");
    expect(committed).toEqual([]);
    const restarted = new FileProtocolStore(path);
    const market = restarted.markets.get(marketId)!;
    restarted.updateMarket({ ...market, fundingIndex: 77n, initialMarginRate: 999_999n, maxLeverage: 1n });
    let rematches = 0;
    const recovered = await new BatchExecutorService(executor(restarted, committed) as never, {
      createSettlementTranscript() { rematches++; throw new Error("original batch must not be reproved from current market"); },
    }, { intervalMs: 1000, settlementsOnchainRequired: true }, relay as never).runOnce({ now: 200 });
    expect(recovered.results[0]!.record.status).toBe("settled");
    expect(rematches).toBe(0);
    expect(sends).toBe(1);
    expect(JSON.parse(encode(committed))).toEqual(JSON.parse(encode([{ ...original, settlement: { ...original.settlement, onchainConfirmed: true } }])));
    expect(committed[0]!.positionOpenings.every((opening) => opening.fundingIndex === 0n)).toBe(true);
    expect(restarted.positionMembershipRoot()).not.toBe(store.positionMembershipRoot());
    const durable = new FileProtocolStore(path);
    expect(durable.accountEvents.get(key("event"))?.ciphertext).toBe("original-private-output-envelope");
    const publicValues = [first, recovered, new IndexerService(durable).snapshot(),
      ...[...durable.intents.values()].map((intent) => new IndexerService(durable).ordersFor(intent.ownerCommitment))];
    for (const value of publicValues) {
      const json = encode(value);
      expect(json).not.toContain("settlementTranscript");
      expect(json).not.toContain("original-private-output-envelope");
      expect(json).not.toContain(key("private-position-seed-0"));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const method of ["settle", "commitExternal"] as const) {
  test(`${method} uses the shared journal for File restart recovery and idempotent API retries`, async () => {
    const root = mkdtempSync(join(tmpdir(), "pnlx-api-batch-journal-"));
    try {
      const path = join(root, "store.json");
      let store = new FileProtocolStore(path); seed(store);
      const input = { batchId: "client-order", marketId, intentCommitments: [...store.privateMatchIntents.keys()] };
      const original = transcript(store, input);
      let settled = false; let sends = 0; let matches = 0;
      const committed: ExternalBatchSettlementTranscript[] = [];
      const relay = { enabled: true, positionRoot: () => store.positionMembershipRoot(),
        isBatchSettled: () => settled, batchPositionAppendIndexAsync: async () => 0,
        settleBatch(value: BatchSettlement) {
          sends++;
          const journal = [...store.batchExecutionRuns.values()][0]!;
          expect(journal.submissionAttempted).toBe(true);
          expect(journal.settlementTranscript?.settlement.settlementDigest).toBe(original.settlement.settlementDigest);
          expect(value.batchId).toBe("client-order");
          settled = true;
          throw new Error("response lost after settlement");
        } };
      const createService = () => {
        const target = executor(store, committed);
        const worker = new BatchExecutorService(target as never, { createSettlementTranscript(value) {
          matches++; expect(value.batchId).toBe("client-order"); return original;
        } }, { intervalMs: 1000, settlementsOnchainRequired: true }, relay as never);
        return new BatchesService(target as never, relay as never, [], false, { settlementsOnchainRequired: true }, worker);
      };
      let service = createService();
      const submit = () => method === "settle" ? service.settle(input) : service.commitExternal(original);
      await expect(submit()).rejects.toThrow("response lost");
      expect(committed).toHaveLength(0);
      store = new FileProtocolStore(path);
      store.updateMarket({ ...store.markets.get(marketId)!, fundingIndex: 123n, initialMarginRate: 999_999n });
      service = createService();
      if (method === "commitExternal") {
        const changed = { ...original, accountEvents: [{ ...original.accountEvents[0]!, ciphertext: "replacement-output-envelope" }] };
        await expect(service.commitExternal(changed)).rejects.toThrow("conflicting batch settlement transcript");
      }
      const result = await submit();
      expect(result.settlementDigest).toBe(original.settlement.settlementDigest);
      expect(result.onchainConfirmed).toBe(true);
      expect(committed).toHaveLength(1);
      expect(committed[0]!.positionOpenings.every((opening) => opening.fundingIndex === 0n)).toBe(true);
      expect(await submit()).toEqual(result);
      expect(committed).toHaveLength(1); expect(sends).toBe(1);
      expect(matches).toBe(method === "settle" ? 1 : 0);
      expect(encode(result)).not.toContain("original-private-output-envelope");
      expect(encode(result)).not.toContain("settlementTranscript");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("external API validates before journaling and rejects an unconfirmed over-budget proof before relay", async () => {
  const root = mkdtempSync(join(tmpdir(), "pnlx-api-batch-budget-"));
  try {
    const store = new FileProtocolStore(join(root, "store.json")); seed(store, [1n, -1n, 1n, -1n]);
    const original = transcript(store, { batchId: "client-order", marketId, intentCommitments: [...store.privateMatchIntents.keys()] });
    expect(original.settlement.fillCount).toBe(4);
    let sends = 0;
    const relay = { enabled: true, isBatchSettled: () => false, settleBatch() { sends++; } };
    const target = executor(store, []);
    const worker = new BatchExecutorService(target as never, {} as never,
      { intervalMs: 1000, settlementsOnchainRequired: true }, relay as never);
    const service = new BatchesService(target as never, relay as never, [], false, { settlementsOnchainRequired: true }, worker);
    await expect(service.commitExternal({ ...original, accountEvents: [] })).rejects.toThrow("account events required");
    expect(store.batchExecutionRuns.size).toBe(0);
    await expect(service.commitExternal(original)).rejects.toThrow("batch relay budget supports at most 1");
    expect(sends).toBe(0);
    expect([...store.batchExecutionRuns.values()].every((run) => !run.submissionAttempted)).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("legacy attempted batch without original transcript retains uncertainty instead of rematching", async () => {
  const root = mkdtempSync(join(tmpdir(), "pnlx-legacy-batch-"));
  try {
    const store = new FileProtocolStore(join(root, "store.json")); seed(store);
    store.upsertBatchExecutionRun({ runId: key("legacy"), batchId: "legacy", marketId, startedAt: 1,
      status: "failed", phase: "batch-settlement", settlementDigest: key("legacy-digest"), submissionAttempted: true,
      intentCommitments: [...store.privateMatchIntents.keys()] });
    let matches = 0; let sends = 0;
    const result = await new BatchExecutorService(executor(store, []) as never, {
      createSettlementTranscript() { matches++; throw new Error("must not replace uncertain proof"); },
    }, { intervalMs: 1000, settlementsOnchainRequired: true }, { settleBatch() { sends++; } } as never).runOnce();
    expect(result.results[0]!.record.reason).toContain("original settlement transcript");
    expect(matches).toBe(0); expect(sends).toBe(0);
    expect(store.batchExecutionRuns.get(key("legacy"))?.submissionAttempted).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
