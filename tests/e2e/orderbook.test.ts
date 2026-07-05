import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { commitIntent, hashFields, intentBindingFields } from "@pnlx/crypto";
import { PRICE_SCALE } from "@pnlx/market-math";
import type { BatchSettlement, Hex, IntentValidityRecord, MarketConfig, PrivateMatchIntent, ProofMeta, TradeIntent } from "@pnlx/protocol-types";
import { createMarginNote } from "@pnlx/sdk";
import { BatchMatcherService } from "@/workers/batch-matcher/batch-matcher.service";
import type { MatchResult } from "@/workers/batch-matcher/batch-matcher.model";
import { createExecutor } from "@/workers/executor/executor.worker";
import { ExecutorService } from "@/workers/executor/executor.service";
import { createIndexer } from "@/workers/indexer/indexer.worker";
import { createMatcher } from "@/workers/matcher/matcher.worker";
import type { SettlementProofInput } from "@/workers/proof-coordinator/proof-coordinator.model";
import { batchSettlementPublicInputHash } from "@/shared/protocol/batch-settlement-proof";
import { FileProtocolStore } from "@/shared/state/persistent-store";

describe("private orderbook residuals", () => {
  test("matches crossed private orders by price-time priority at maker price", () => {
    const matcher = new BatchMatcherService();
    const market = testMarket();
    const betterLateLong = recoveredIntent("better-late-long", "long", 1n, 53_000n * PRICE_SCALE, 12_000n);
    const firstLong = recoveredIntent("first-long", "long", 1n, 52_000n * PRICE_SCALE, 12_000n);
    const firstShort = recoveredIntent("first-short", "short", 1n, 49_000n * PRICE_SCALE, 12_000n);

    const pricePriority = matcher.match({
      batchId: "price-priority",
      market,
      intents: [firstLong, betterLateLong, firstShort],
    });

    expect(pricePriority.executions).toEqual([
      expect.objectContaining({
        longIntentCommitment: betterLateLong.intentCommitment,
        makerIntentCommitment: betterLateLong.intentCommitment,
        price: betterLateLong.limitPrice,
        shortIntentCommitment: firstShort.intentCommitment,
      }),
    ]);
    expect(pricePriority.orderUpdates.map((update) => update.intentCommitment)).toEqual([
      betterLateLong.intentCommitment,
      firstShort.intentCommitment,
    ]);

    const secondLong = recoveredIntent("second-long", "long", 1n, 52_000n * PRICE_SCALE, 12_000n);
    const timePriority = matcher.match({
      batchId: "time-priority",
      market,
      intents: [firstLong, secondLong, firstShort],
    });

    expect(timePriority.executions).toEqual([
      expect.objectContaining({
        longIntentCommitment: firstLong.intentCommitment,
        makerIntentCommitment: firstLong.intentCommitment,
        price: firstLong.limitPrice,
        shortIntentCommitment: firstShort.intentCommitment,
      }),
    ]);
    expect(timePriority.orderUpdates.map((update) => update.intentCommitment)).toEqual([
      firstLong.intentCommitment,
      firstShort.intentCommitment,
    ]);
  });

  test("emits executable residual intents after partial fills", () => {
    const matcher = new BatchMatcherService();
    const market = testMarket();
    const first = matcher.match({
      batchId: "residual-match-1",
      market,
      intents: [
        recoveredIntent("residual-long", "long", 2n, 52_000n * PRICE_SCALE, 24_000n),
        recoveredIntent("residual-short-1", "short", 1n, 49_000n * PRICE_SCALE, 12_000n),
      ],
    });

    expect(first.residuals).toEqual([
      expect.objectContaining({
        limitPrice: 52_000n * PRICE_SCALE,
        margin: 12_000n,
        marketId: market.marketId,
        signedSize: 1n,
        sourceIntentCommitment: hashFields("intent", ["residual-long"]),
      }),
    ]);
    const firstResidualUpdate = first.orderUpdates.find((update) => update.status === "partially-filled");
    if (!firstResidualUpdate?.residualCommitment) throw new Error("missing residual commitment");
    expect(first.residuals[0].intentCommitment).toBe(firstResidualUpdate.residualCommitment);
    expect(first.residuals[0].noteNullifier).not.toBe(hashFields("nullifier", ["residual-long"]));

    const second = matcher.match({
      batchId: "residual-match-2",
      market,
      intents: [
        first.residuals[0],
        recoveredIntent("residual-short-2", "short", 1n, 49_000n * PRICE_SCALE, 12_000n),
      ],
    });

    expect(second.residuals).toHaveLength(0);
    expect(second.orderUpdates.map((update) => update.status)).toEqual(["filled", "filled"]);
    expect(second.spentNullifiers).toContain(first.residuals[0].noteNullifier);
  });

  test("persists residual orders and fills them in a later batch", () => {
    const storePath = join(mkdtempSync(join(tmpdir(), "pnlx-orderbook-")), "store.json");
    const firstExecutor = createFileExecutor(storePath);
    installFastSettlementProofs(firstExecutor);
    const market = testMarket();
    firstExecutor.addMarket(market);

    const alice = backedIntent(firstExecutor, {
      batchId: "batch-1",
      limitPrice: 52_000n * PRICE_SCALE,
      margin: 24_000n,
      marketId: market.marketId,
      owner: "alice",
      side: "long",
      size: 2n,
    });
    const bob = backedIntent(firstExecutor, {
      batchId: "batch-1",
      limitPrice: 49_000n * PRICE_SCALE,
      margin: 12_000n,
      marketId: market.marketId,
      owner: "bob",
      side: "short",
      size: 1n,
    });

    const firstSettlement = firstExecutor.settleBatch({
      batchId: "batch-1",
      marketId: market.marketId,
    });
    const aliceCommitment = commitIntent(alice.intent);
    const residualCommitment = firstSettlement.orderUpdates.find(
      (update) => update.intentCommitment === aliceCommitment,
    )?.residualCommitment;
    if (!residualCommitment) throw new Error("missing residual commitment");

    expect(residualCommitment).toMatch(/^0x[0-9a-f]{64}$/);
    expect(firstExecutor.store.orderLifecycle.get(aliceCommitment)?.status).toBe("partially-filled");
    expect(firstExecutor.store.residualOrders.size).toBe(1);
    const sealedResidual = firstExecutor.store.residualOrders.get(residualCommitment)!;
    expect(sealedResidual.matchingPayloadCommitment).toMatch(/^0x[0-9a-f]{64}$/);
    expect("signedSize" in sealedResidual).toBe(false);
    expect("limitPrice" in sealedResidual).toBe(false);
    expect("margin" in sealedResidual).toBe(false);
    expect(firstExecutor.store.privateMatchIntents.get(residualCommitment)).toMatchObject({
      intentCommitment: residualCommitment,
      limitPrice: 52_000n * PRICE_SCALE,
      margin: 12_000n,
      signedSize: 1n,
    });
    expect(firstExecutor.store.spentNullifiers.has(alice.note.nullifier as Hex)).toBe(true);
    expect(firstExecutor.store.spentNullifiers.has(bob.note.nullifier as Hex)).toBe(true);

    const secondExecutor = createFileExecutor(storePath);
    installFastSettlementProofs(secondExecutor);
    const carol = backedIntent(secondExecutor, {
      batchId: "batch-2",
      limitPrice: 49_000n * PRICE_SCALE,
      margin: 12_000n,
      marketId: market.marketId,
      owner: "carol",
      side: "short",
      size: 1n,
    });
    const residual = secondExecutor.store.residualOrders.get(residualCommitment)!;
    const beforeSecondOrders = createIndexer(secondExecutor.store).ordersFor(
      residual.ownerCommitment,
    );
    expect(beforeSecondOrders.find((order) => order.intentCommitment === residualCommitment))
      .toMatchObject({
        isResidual: true,
        sourceIntentCommitment: aliceCommitment,
        status: "open",
      });

    const secondSettlement = secondExecutor.settleBatch({
      batchId: "batch-2",
      marketId: market.marketId,
    });

    expect(secondSettlement.orderUpdates.map((update) => update.intentCommitment)).toEqual([
      residualCommitment,
      commitIntent(carol.intent),
    ]);
    expect(secondExecutor.store.orderLifecycle.get(residualCommitment)?.status).toBe("filled");
    expect(secondExecutor.store.orderLifecycle.get(commitIntent(carol.intent))?.status).toBe("filled");
    expect(secondSettlement.spentNullifiers).toContain(residual.noteNullifier);
    expect(secondSettlement.spentNullifiers).toContain(carol.note.nullifier as Hex);
    expect(secondSettlement.spentNullifiers).not.toContain(alice.note.nullifier as Hex);
  });

  test("settles an external private batch with RISC0 receipt metadata", async () => {
    const executor = createExecutor();
    const market = testMarket();
    executor.addMarket(market);
    backedIntent(executor, {
      batchId: "risc0-flow",
      limitPrice: 52_000n * PRICE_SCALE,
      margin: 12_000n,
      marketId: market.marketId,
      owner: "risc0-alice",
      side: "long",
      size: 1n,
    });
    backedIntent(executor, {
      batchId: "risc0-flow",
      limitPrice: 49_000n * PRICE_SCALE,
      margin: 12_000n,
      marketId: market.marketId,
      owner: "risc0-bob",
      side: "short",
      size: 1n,
    });

    const matcher = createMatcher(executor, {
      accountEventEncryptor: (payload) => JSON.stringify(payload, bigintStringify),
      proofs: fastSettlementProofs() as never,
    });
    const transcript = await matcher.createSettlementTranscript({
      batchId: "risc0-flow",
      marketId: market.marketId,
    });

    expect(transcript.settlement.proof).toMatchObject({
      circuitId: "batch-match",
      proofSystem: "risc0-groth16",
    });
    expect(transcript.settlement.proof.imageId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(transcript.settlement.proof.journalDigest).toBe(batchSettlementPublicInputHash(transcript.settlement));
    expect(transcript.settlement.proof.sealDigest).toBe(transcript.settlement.proof.proofDigest);
    expect(transcript.accountEvents).toHaveLength(2);

    const settlement = executor.commitExternalBatchSettlement(transcript, { proofVerified: true });

    expect(settlement.fillCount).toBe(2);
    expect(executor.store.settlements.has(`${market.marketId}:risc0-flow`)).toBe(true);
    expect(executor.store.positionLifecycle.size).toBe(2);
  });

  test("persists cancelled order lifecycle state", () => {
    const storePath = join(mkdtempSync(join(tmpdir(), "pnlx-order-cancel-")), "store.json");
    const executor = createFileExecutor(storePath);
    executor.addMarket(testMarket());
    const alice = backedIntent(executor, {
      batchId: "cancel-batch",
      limitPrice: 52_000n * PRICE_SCALE,
      margin: 12_000n,
      marketId: "btc-usd-perp",
      owner: "alice-cancel",
      side: "long",
      size: 1n,
    });
    const intentCommitment = commitIntent(alice.intent);

    expect(executor.store.cancelOrder(intentCommitment).status).toBe("cancelled");

    const reloaded = createFileExecutor(storePath);
    expect(reloaded.store.orderLifecycle.get(intentCommitment)?.status).toBe("cancelled");
  });
});

function installFastSettlementProofs(executor: ExecutorService): void {
  (executor as unknown as { proofs: unknown }).proofs = fastSettlementProofs();
}

function fastSettlementProofs() {
  return {
    artifactFor() {
      return undefined;
    },
    createSettlement(input: SettlementProofInput): BatchSettlement {
      const draft = {
        aggregateVolume: input.match.aggregateVolume,
        batchId: input.batchId,
        fillCount: input.match.fills.length,
        matchTranscriptDigest: input.match.matchTranscriptDigest,
        marginChangeCommitments: input.match.marginChangeCommitments,
        marketId: input.market.marketId,
        newCommitments: input.match.fills.map((fill) => fill.positionCommitment),
        newRoot: input.newRoot,
        oldRoot: input.oldRoot,
        openInterestDelta: input.match.openInterestDelta,
        orderUpdates: input.match.orderUpdates,
        residualSize: input.match.residualSize,
        settlementDigest: hashFields("settlement", [
          input.batchId,
          input.market.marketId,
          input.match.orderUpdates,
        ]),
        spentNullifiers: input.match.spentNullifiers,
      };
      const publicInputHash = batchSettlementPublicInputHash({
        ...draft,
        proof: proofMeta("batch-match", [input.batchId, input.market.marketId, input.newRoot]),
      });
      const sealDigest = hashFields("risc0-seal", [input.batchId, input.market.marketId, input.newRoot]);
      return {
        ...draft,
        proof: {
          ...proofMeta("batch-match", [input.batchId, input.market.marketId, input.newRoot]),
          imageId: hashFields("risc0-image", [input.batchId, input.market.marketId]),
          journalDigest: publicInputHash,
          proofDigest: sealDigest,
          proofSystem: "risc0-groth16",
          publicInputHash,
          sealDigest,
        },
      };
    },
  };
}

function backedIntent(
  executor: ExecutorService,
  input: {
    batchId: string;
    limitPrice: bigint;
    margin: bigint;
    marketId: string;
    owner: string;
    side: "long" | "short";
    size: bigint;
  },
): { intent: TradeIntent; note: ReturnType<typeof createMarginNote> } {
  const note = createMarginNote({
    assetId: "usdc",
    amount: input.margin,
    blinding: `${input.owner}-${input.batchId}-blind`,
    owner: input.owner,
    rho: `${input.owner}-${input.batchId}-rho`,
    spendSecret: `${input.owner}-${input.batchId}-spend`,
  });
  executor.deposit(note.commitment as Hex);
  const intent: TradeIntent = {
    batchId: input.batchId,
    limitPrice: input.limitPrice,
    margin: input.margin,
    marketId: input.marketId,
    nonce: `${input.owner}-${input.batchId}-nonce`,
    noteNullifier: note.nullifier as Hex,
    owner: input.owner,
    salt: `${input.owner}-${input.batchId}-salt`,
    side: input.side,
    size: input.size,
  };
  executor.submitIntent({ intent, validity: createIntentValidity(executor, intent) });
  return { intent, note };
}

function createIntentValidity(
  executor: ExecutorService,
  intent: TradeIntent,
): IntentValidityRecord {
  const intentCommitment = commitIntent(intent);
  const binding = intentBindingFields(intent);
  const marginRoot = executor.store.marginMembershipRoot();
  const noteCommitment = hashFields("note-commitment", [intentCommitment, marginRoot]);
  const proof = proofMeta("intent-validity", [
    intentCommitment,
    marginRoot,
    noteCommitment,
    intent.noteNullifier,
  ]);
  executor.store.recordProof(proof);
  return {
    batchDigest: binding.batchDigest,
    currentBatch: 1n,
    expiryBatch: 10n,
    intentCommitment,
    marketDigest: binding.marketDigest,
    marginRoot,
    noteChangeCommitment: "0x0",
    noteCommitment,
    noteNullifier: intent.noteNullifier,
    ownerCommitmentField: binding.ownerCommitmentField,
    proof,
  };
}

function recoveredIntent(
  id: string,
  side: "long" | "short",
  size: bigint,
  limitPrice: bigint,
  margin: bigint,
): PrivateMatchIntent {
  return {
    batchId: "matcher-test",
    intentCommitment: hashFields("intent", [id]),
    limitPrice,
    margin,
    marketId: "btc-usd-perp",
    noteChangeCommitment: "0x0",
    noteNullifier: hashFields("nullifier", [id]),
    ownerCommitment: hashFields("owner", [id]),
    signedSize: side === "long" ? size : -size,
  };
}

function testMarket(): MarketConfig {
  return {
    fundingIndex: 0n,
    initialMarginRate: 200_000n,
    maintenanceMarginRate: 100_000n,
    marketId: "btc-usd-perp",
    maxLeverage: 5n,
    oraclePrice: 50_000n * PRICE_SCALE,
  };
}

function proofMeta(label: string, fields: unknown[]): ProofMeta {
  const digest = hashFields(label, fields);
  return {
    circuitHash: hashFields("circuit-hash", [label]),
    circuitId: label,
    circuitKey: hashFields("circuit-key", [label]),
    proofDigest: hashFields("proof-digest", [digest]),
    publicInputHash: hashFields("public-input", [digest]),
    verifierHash: hashFields("verifier", [label]),
  };
}

function createFileExecutor(storePath: string): ExecutorService {
  return new ExecutorService({}, new FileProtocolStore(storePath));
}

function bigintStringify(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}
