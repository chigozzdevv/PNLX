import { describe, expect, test } from "bun:test";
import { commitIntent, hashFields, intentBindingFields, ownerCommitment, recoverSecret } from "@merkl/crypto";
import { PRICE_SCALE, RATE_SCALE } from "@merkl/market-math";
import { circuitKey, loadCircuit } from "@merkl/proof-system";
import type { Hex, IntentValidityRecord, MarketConfig, ProofMeta, TradeIntent } from "@merkl/protocol-types";
import { createMarginNote } from "@merkl/sdk";
import { readFileSync } from "node:fs";
import { BatchMatcherService } from "@/workers/batch-matcher/batch-matcher.service";
import type { RecoveredIntent } from "@/workers/threshold-shares/threshold-shares.model";
import { ProofCoordinatorService } from "@/workers/proof-coordinator/proof-coordinator.service";
import { ThresholdShareCommittee } from "@/workers/threshold-shares/threshold-shares.service";
import { createExecutor } from "@/workers/executor/executor.worker";

describe("private batch settlement", () => {
  test("keeps raw match fill handling outside the executor boundary", () => {
    const source = readFileSync(
      "server/src/workers/executor/executor.service.ts",
      "utf8",
    );

    expect(source).not.toContain("match.fills");
    expect(source).not.toContain("match.residuals");
    expect(source).not.toContain("createPositionOpenings");
    expect(source).toContain("createSettlementTranscript");
  });

  test("matches crossed orders at maker price", () => {
    const matcher = new BatchMatcherService();
    const market = testMarket();
    const bid = 51_000n * PRICE_SCALE;
    const ask = 49_000n * PRICE_SCALE;

    const longMaker = matcher.match({
      batchId: "maker-long",
      market,
      intents: [
        recoveredIntent("long-maker", "long", 1n, bid),
        recoveredIntent("short-taker", "short", 1n, ask),
      ],
    });
    expect(longMaker.executions[0].makerSide).toBe("long");
    expect(longMaker.executions[0].price).toBe(bid);

    const shortMaker = matcher.match({
      batchId: "maker-short",
      market,
      intents: [
        recoveredIntent("short-maker", "short", 1n, ask),
        recoveredIntent("long-taker", "long", 1n, bid),
      ],
    });
    expect(shortMaker.executions[0].makerSide).toBe("short");
    expect(shortMaker.executions[0].price).toBe(ask);
  });

  test("uses price priority before time priority and fifo within a price level", () => {
    const matcher = new BatchMatcherService();
    const market = testMarket();
    const lowBid = recoveredIntent("low-bid-first", "long", 1n, 50_000n * PRICE_SCALE);
    const highBid = recoveredIntent("high-bid-second", "long", 1n, 51_000n * PRICE_SCALE);
    const ask = recoveredIntent("ask", "short", 1n, 49_000n * PRICE_SCALE);

    const pricePriority = matcher.match({
      batchId: "price-priority",
      market,
      intents: [lowBid, highBid, ask],
    });
    expect(pricePriority.executions[0].longIntentCommitment).toBe(highBid.intentCommitment);

    const firstAtLevel = recoveredIntent("first-at-level", "long", 1n, 51_000n * PRICE_SCALE);
    const secondAtLevel = recoveredIntent("second-at-level", "long", 1n, 51_000n * PRICE_SCALE);
    const fifo = matcher.match({
      batchId: "fifo",
      market,
      intents: [firstAtLevel, secondAtLevel, ask],
    });
    expect(fifo.executions[0].longIntentCommitment).toBe(firstAtLevel.intentCommitment);
  });

  test("rejects duplicate note nullifiers inside one private batch", () => {
    const matcher = new BatchMatcherService();
    const market = testMarket();
    const duplicate = hashFields("nullifier", ["duplicate-batch"]);

    expect(() =>
      matcher.match({
        batchId: "duplicate-nullifier",
        market,
        intents: [
          recoveredIntent("duplicate-long", "long", 1n, 51_000n * PRICE_SCALE, duplicate),
          recoveredIntent("duplicate-short", "short", 1n, 49_000n * PRICE_SCALE, duplicate),
        ],
      }),
    ).toThrow("duplicate intent nullifier");
  });

  test("returns private margin change commitments for partial fills", () => {
    const matcher = new BatchMatcherService();
    const market = testMarket();
    const result = matcher.match({
      batchId: "partial-margin-change",
      market,
      intents: [
        recoveredIntent("partial-long", "long", 3n, 52_000n * PRICE_SCALE),
        recoveredIntent("partial-short-a", "short", 1n, 49_000n * PRICE_SCALE),
        recoveredIntent("partial-short-b", "short", 1n, 49_000n * PRICE_SCALE),
      ],
    });
    const longFillMargin = result.fills
      .filter((fill) => fill.side === "long")
      .reduce((sum, fill) => sum + fill.margin, 0n);

    expect(result.marginChangeCommitments).toHaveLength(1);
    expect(result.orderUpdates).toEqual([
      {
        intentCommitment: hashFields("intent", ["partial-long"]),
        residualCommitment: expect.stringMatching(/^0x[0-9a-f]{64}$/),
        status: "partially-filled",
      },
      {
        intentCommitment: hashFields("intent", ["partial-short-a"]),
        status: "filled",
      },
      {
        intentCommitment: hashFields("intent", ["partial-short-b"]),
        status: "filled",
      },
    ]);
    expect(longFillMargin).toBe(24_000n);
    expect(result.spentNullifiers).toContain(hashFields("nullifier", ["partial-long"]));
  });

  test("does not match plaintext residual fallback without threshold shares", () => {
    const committee = new ThresholdShareCommittee({
      nodeIds: ["node-a", "node-b", "node-c"],
      threshold: 2,
    });
    const legacyPlaintextResidual = {
      batchId: "legacy-batch",
      createdAt: 1,
      intentCommitment: hashFields("legacy-residual", ["intent"]),
      limitPrice: 52_000n * PRICE_SCALE,
      margin: 12_000n,
      marketId: "btc-usd-perp",
      noteNullifier: hashFields("legacy-residual", ["nullifier"]),
      ownerCommitment: ownerCommitment("legacy-residual"),
      shareCommitment: hashFields("legacy-residual", ["shares"]),
      signedSize: 1n,
      sourceIntentCommitment: hashFields("legacy-residual", ["source"]),
      updatedAt: 1,
    };

    expect(() =>
      committee.matchBatch({
        batchId: "next-batch",
        market: testMarket(),
        records: [],
        residuals: [legacyPlaintextResidual as never],
      }),
    ).toThrow("not enough shares to recover intent");
  });

  test("reports nonnegative residual size for short-heavy partial fills", () => {
    const matcher = new BatchMatcherService();
    const market = testMarket();
    const result = matcher.match({
      batchId: "short-heavy-partial",
      market,
      intents: [
        recoveredIntent("short-heavy-long", "long", 1n, 52_000n * PRICE_SCALE),
        recoveredIntent("short-heavy-short", "short", 2n, 49_000n * PRICE_SCALE),
      ],
    });

    expect(result.aggregateVolume).toBe(2n);
    expect(result.residualSize).toBe(1n);
    expect(result.totalLongSize).toBe(1n);
    expect(result.totalShortSize).toBe(2n);
  });

  test("rejects tampered match transcripts before proof generation", () => {
    const matcher = new BatchMatcherService();
    const market = testMarket();
    const match = matcher.match({
      batchId: "tampered-transcript",
      market,
      intents: [
        recoveredIntent("tampered-long", "long", 1n, 52_000n * PRICE_SCALE),
        recoveredIntent("tampered-short", "short", 1n, 49_000n * PRICE_SCALE),
      ],
    });
    const proofs = new ProofCoordinatorService();

    expect(() =>
      proofs.createSettlement({
        batchId: "tampered-transcript",
        market,
        oldRoot: hashFields("old-root", ["tampered-transcript"]),
        newRoot: hashFields("new-root", ["tampered-transcript"]),
        match: {
          ...match,
          matchTranscriptDigest: hashFields("bad-transcript", []),
        },
      }),
    ).toThrow("match transcript digest mismatch");
  });

  test("settles crossed long and short intents without storing plaintext intents", () => {
    const executor = createExecutor();

    const market: MarketConfig = {
      marketId: "btc-usd-perp",
      oraclePrice: 50_000n * PRICE_SCALE,
      maxLeverage: 5n,
      initialMarginRate: 200_000n,
      maintenanceMarginRate: 100_000n,
      fundingIndex: 0n,
    };

    executor.addMarket(market);

    const aliceNote = createMarginNote({
      assetId: "usdc",
      amount: 20_000n,
      owner: "alice",
      spendSecret: "alice-spend",
      rho: "alice-rho-1",
      blinding: "alice-blind-1",
    });
    const bobNote = createMarginNote({
      assetId: "usdc",
      amount: 20_000n,
      owner: "bob",
      spendSecret: "bob-spend",
      rho: "bob-rho-1",
      blinding: "bob-blind-1",
    });

    executor.deposit(aliceNote.commitment as `0x${string}`);
    executor.deposit(bobNote.commitment as `0x${string}`);

    const aliceIntent: TradeIntent = {
      batchId: "batch-1",
      marketId: market.marketId,
      owner: "alice",
      side: "long",
      size: 1n,
      limitPrice: 51_000n * PRICE_SCALE,
      margin: 12_000n,
      noteNullifier: aliceNote.nullifier as `0x${string}`,
      nonce: "alice-intent-1",
      salt: "alice-intent-salt",
    };
    const bobIntent: TradeIntent = {
      batchId: "batch-1",
      marketId: market.marketId,
      owner: "bob",
      side: "short",
      size: 1n,
      limitPrice: 49_000n * PRICE_SCALE,
      margin: 12_000n,
      noteNullifier: bobNote.nullifier as `0x${string}`,
      nonce: "bob-intent-1",
      salt: "bob-intent-salt",
    };

    submitBackedIntent(executor, aliceIntent);
    submitBackedIntent(executor, bobIntent);

    const aliceCommitment = commitIntent(aliceIntent);
    const aliceStored = executor.store.intents.get(aliceCommitment);
    expect(aliceStored?.intentCommitment).toBe(aliceCommitment);
    expect(JSON.stringify(aliceStored)).not.toContain("long");
    expect(JSON.stringify(aliceStored)).not.toContain("51000");

    const firstNodeShare = executor.committee.nodes[0].get(aliceCommitment);
    expect(firstNodeShare).toBeTruthy();
    expect(() => recoverSecret([firstNodeShare!.signedSize])).toThrow();
    expect("recoverIntent" in executor.committee).toBe(false);
    expect("matcher" in executor).toBe(false);

    const settlement = executor.settleBatch({
      batchId: "batch-1",
      marketId: market.marketId,
    });

    expect(settlement.fillCount).toBe(2);
    expect(settlement.newCommitments).toHaveLength(2);
    expect(settlement.marginChangeCommitments).toHaveLength(0);
    expect(settlement.residualSize).toBe(0n);
    expect(settlement.aggregateVolume).toBe(2n);
    expect(settlement.oldRoot).not.toBe(settlement.newRoot);
    expect(settlement.spentNullifiers).toContain(aliceNote.nullifier as `0x${string}`);
    expect(settlement.spentNullifiers).toContain(bobNote.nullifier as `0x${string}`);
    expect(executor.store.spentNullifiers.has(aliceNote.nullifier as `0x${string}`)).toBe(true);
    expect(executor.store.positionCommitments.size).toBe(2);
    expect(executor.store.positionLifecycle.size).toBe(2);
    expect(executor.store.positionsFor(ownerCommitment("alice"))).toEqual([
      expect.objectContaining({
        ownerCommitment: ownerCommitment("alice"),
        positionCommitment: settlement.newCommitments[0],
        sourceIntentCommitment: aliceCommitment,
        status: "open",
      }),
    ]);
    const batchCircuit = loadCircuit(process.cwd(), "batch-match");
    expect(settlement.proof.proofDigest.startsWith("0x")).toBe(true);
    expect(settlement.proof.circuitId).toBe("batch-match");
    expect(settlement.proof.circuitKey).toBe(circuitKey("batch-match"));
    expect(settlement.proof.circuitHash).toBe(batchCircuit.sourceHash);
    expect(settlement.proof.proofHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(settlement.proof.vkHash).toBe(settlement.proof.verifierHash);
    expect(executor.store.hasProof(settlement.proof)).toBe(true);
    const artifact = executor.artifactFor(settlement.proof);
    expect(artifact?.proofPath).toContain("proof");
    expect(createExecutor().artifactFor(settlement.proof)?.proofPath).toBe(artifact?.proofPath);
    const publicSettlement = JSON.stringify(settlement, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    expect(publicSettlement).not.toContain("long");
    expect(publicSettlement).not.toContain("short");
    expect(publicSettlement).not.toContain("positionNullifier");
  });

  test("excludes cancelled orders from private settlement", () => {
    const executor = createExecutor();
    const market = testMarket();
    executor.addMarket(market);

    const cancelledNote = createMarginNote({
      assetId: "usdc",
      amount: 20_000n,
      owner: "cancelled-long",
      spendSecret: "cancelled-long-spend",
      rho: "cancelled-long-rho",
      blinding: "cancelled-long-blind",
    });
    const activeNote = createMarginNote({
      assetId: "usdc",
      amount: 20_000n,
      owner: "active-long",
      spendSecret: "active-long-spend",
      rho: "active-long-rho",
      blinding: "active-long-blind",
    });
    const shortNote = createMarginNote({
      assetId: "usdc",
      amount: 20_000n,
      owner: "active-short",
      spendSecret: "active-short-spend",
      rho: "active-short-rho",
      blinding: "active-short-blind",
    });

    executor.deposit(cancelledNote.commitment as Hex);
    executor.deposit(activeNote.commitment as Hex);
    executor.deposit(shortNote.commitment as Hex);

    const cancelledIntent: TradeIntent = {
      batchId: "cancel-filter-batch",
      marketId: market.marketId,
      owner: "cancelled-long",
      side: "long",
      size: 1n,
      limitPrice: 51_000n * PRICE_SCALE,
      margin: 12_000n,
      noteNullifier: cancelledNote.nullifier as Hex,
      nonce: "cancelled-long-intent",
      salt: "cancelled-long-salt",
    };
    const activeIntent: TradeIntent = {
      batchId: "cancel-filter-batch",
      marketId: market.marketId,
      owner: "active-long",
      side: "long",
      size: 1n,
      limitPrice: 51_000n * PRICE_SCALE,
      margin: 12_000n,
      noteNullifier: activeNote.nullifier as Hex,
      nonce: "active-long-intent",
      salt: "active-long-salt",
    };
    const shortIntent: TradeIntent = {
      batchId: "cancel-filter-batch",
      marketId: market.marketId,
      owner: "active-short",
      side: "short",
      size: 1n,
      limitPrice: 49_000n * PRICE_SCALE,
      margin: 12_000n,
      noteNullifier: shortNote.nullifier as Hex,
      nonce: "active-short-intent",
      salt: "active-short-salt",
    };

    submitBackedIntent(executor, cancelledIntent);
    submitBackedIntent(executor, activeIntent);
    submitBackedIntent(executor, shortIntent);

    const cancelledCommitment = commitIntent(cancelledIntent);
    const activeCommitment = commitIntent(activeIntent);
    const shortCommitment = commitIntent(shortIntent);
    expect(executor.store.cancelOrder(cancelledCommitment).status).toBe("cancelled");

    const settlement = executor.settleBatch({
      batchId: "cancel-filter-batch",
      marketId: market.marketId,
    });

    expect(settlement.fillCount).toBe(2);
    expect(settlement.orderUpdates.map((update) => update.intentCommitment)).toEqual([
      activeCommitment,
      shortCommitment,
    ]);
    expect(settlement.spentNullifiers).not.toContain(cancelledNote.nullifier as Hex);
    expect(executor.store.orderLifecycle.get(cancelledCommitment)?.status).toBe("cancelled");
    expect(executor.store.orderLifecycle.get(activeCommitment)?.status).toBe("filled");
    expect(executor.store.orderLifecycle.get(shortCommitment)?.status).toBe("filled");
  });

  test("rejects trades above market max leverage even when initial margin would pass", () => {
    const executor = createExecutor();

    const market: MarketConfig = {
      marketId: "btc-usd-perp",
      oraclePrice: 50_000n * PRICE_SCALE,
      maxLeverage: 5n,
      initialMarginRate: 50_000n,
      maintenanceMarginRate: 25_000n,
      fundingIndex: 0n,
    };

    executor.addMarket(market);

    const aliceNote = createMarginNote({
      assetId: "usdc",
      amount: 20_000n,
      owner: "alice",
      spendSecret: "alice-max-lev-spend",
      rho: "alice-max-lev-rho",
      blinding: "alice-max-lev-blind",
    });
    const bobNote = createMarginNote({
      assetId: "usdc",
      amount: 20_000n,
      owner: "bob",
      spendSecret: "bob-max-lev-spend",
      rho: "bob-max-lev-rho",
      blinding: "bob-max-lev-blind",
    });

    executor.deposit(aliceNote.commitment as `0x${string}`);
    executor.deposit(bobNote.commitment as `0x${string}`);

    const baseIntent = {
      batchId: "batch-max-leverage",
      marketId: market.marketId,
      size: 1n,
      margin: 9_000n,
    };

    submitBackedIntent(executor, {
      ...baseIntent,
      owner: "alice",
      side: "long",
      limitPrice: 51_000n * PRICE_SCALE,
      noteNullifier: aliceNote.nullifier as `0x${string}`,
      nonce: "alice-max-lev-intent",
      salt: "alice-max-lev-salt",
    });
    submitBackedIntent(executor, {
      ...baseIntent,
      owner: "bob",
      side: "short",
      limitPrice: 49_000n * PRICE_SCALE,
      noteNullifier: bobNote.nullifier as `0x${string}`,
      nonce: "bob-max-lev-intent",
      salt: "bob-max-lev-salt",
    });

    expect(() =>
      executor.settleBatch({
        batchId: "batch-max-leverage",
        marketId: market.marketId,
      }),
    ).toThrow("max leverage exceeded");
  });

  test("rejects non-crossing private order batches", () => {
    const executor = createExecutor();
    const market: MarketConfig = {
      marketId: "btc-usd-perp",
      oraclePrice: 50_000n * PRICE_SCALE,
      maxLeverage: 5n,
      initialMarginRate: 200_000n,
      maintenanceMarginRate: 100_000n,
      fundingIndex: 0n,
    };
    executor.addMarket(market);

    const aliceNote = createMarginNote({
      assetId: "usdc",
      amount: 20_000n,
      owner: "alice",
      spendSecret: "alice-no-cross-spend",
      rho: "alice-no-cross-rho",
      blinding: "alice-no-cross-blind",
    });
    const bobNote = createMarginNote({
      assetId: "usdc",
      amount: 20_000n,
      owner: "bob",
      spendSecret: "bob-no-cross-spend",
      rho: "bob-no-cross-rho",
      blinding: "bob-no-cross-blind",
    });

    submitBackedIntent(executor, {
      batchId: "batch-no-cross",
      marketId: market.marketId,
      owner: "alice",
      side: "long",
      size: 1n,
      limitPrice: 49_000n * PRICE_SCALE,
      margin: 12_000n,
      noteNullifier: aliceNote.nullifier as `0x${string}`,
      nonce: "alice-no-cross-intent",
      salt: "alice-no-cross-salt",
    });
    submitBackedIntent(executor, {
      batchId: "batch-no-cross",
      marketId: market.marketId,
      owner: "bob",
      side: "short",
      size: 1n,
      limitPrice: 51_000n * PRICE_SCALE,
      margin: 12_000n,
      noteNullifier: bobNote.nullifier as `0x${string}`,
      nonce: "bob-no-cross-intent",
      salt: "bob-no-cross-salt",
    });

    expect(() =>
      executor.settleBatch({
        batchId: "batch-no-cross",
        marketId: market.marketId,
      }),
    ).toThrow("batch has no crossed liquidity");
  });

  test("settles partial crossed liquidity and reports residual size", () => {
    const executor = createExecutor();
    const market: MarketConfig = {
      marketId: "btc-usd-perp",
      oraclePrice: 50_000n * PRICE_SCALE,
      maxLeverage: 5n,
      initialMarginRate: 200_000n,
      maintenanceMarginRate: 100_000n,
      fundingIndex: 0n,
    };
    executor.addMarket(market);

    const aliceNote = createMarginNote({
      assetId: "usdc",
      amount: 40_000n,
      owner: "alice",
      spendSecret: "alice-partial-spend",
      rho: "alice-partial-rho",
      blinding: "alice-partial-blind",
    });
    const bobNote = createMarginNote({
      assetId: "usdc",
      amount: 20_000n,
      owner: "bob",
      spendSecret: "bob-partial-spend",
      rho: "bob-partial-rho",
      blinding: "bob-partial-blind",
    });

    submitBackedIntent(executor, {
      batchId: "batch-partial",
      marketId: market.marketId,
      owner: "alice",
      side: "long",
      size: 2n,
      limitPrice: 52_000n * PRICE_SCALE,
      margin: 24_000n,
      noteNullifier: aliceNote.nullifier as `0x${string}`,
      nonce: "alice-partial-intent",
      salt: "alice-partial-salt",
    });
    submitBackedIntent(executor, {
      batchId: "batch-partial",
      marketId: market.marketId,
      owner: "bob",
      side: "short",
      size: 1n,
      limitPrice: 49_000n * PRICE_SCALE,
      margin: 12_000n,
      noteNullifier: bobNote.nullifier as `0x${string}`,
      nonce: "bob-partial-intent",
      salt: "bob-partial-salt",
    });

    const settlement = executor.settleBatch({
      batchId: "batch-partial",
      marketId: market.marketId,
    });

    expect(settlement.fillCount).toBe(2);
    expect(settlement.aggregateVolume).toBe(2n);
    expect(settlement.marginChangeCommitments).toHaveLength(1);
    expect(settlement.orderUpdates).toHaveLength(2);
    expect(settlement.orderUpdates.find((update) => update.intentCommitment === commitIntent({
      batchId: "batch-partial",
      marketId: market.marketId,
      owner: "alice",
      side: "long",
      size: 2n,
      limitPrice: 52_000n * PRICE_SCALE,
      margin: 24_000n,
      noteNullifier: aliceNote.nullifier as `0x${string}`,
      nonce: "alice-partial-intent",
      salt: "alice-partial-salt",
    }))?.status).toBe("partially-filled");
    expect(settlement.residualSize).toBe(1n);
    expect(settlement.spentNullifiers).toContain(aliceNote.nullifier as `0x${string}`);
    expect(settlement.spentNullifiers).toContain(bobNote.nullifier as `0x${string}`);
    expect(executor.store.marginCommitments.has(settlement.marginChangeCommitments[0])).toBe(true);
  });
});

function testMarket(): MarketConfig {
  return {
    marketId: "btc-usd-perp",
    oraclePrice: 50_000n * PRICE_SCALE,
    maxLeverage: 5n,
    initialMarginRate: 200_000n,
    maintenanceMarginRate: 100_000n,
    fundingIndex: 0n,
  };
}

function submitBackedIntent(executor: ReturnType<typeof createExecutor>, intent: TradeIntent): void {
  executor.submitIntent({ intent, validity: createIntentValidity(executor, intent) });
}

function createIntentValidity(
  executor: ReturnType<typeof createExecutor>,
  intent: TradeIntent,
): IntentValidityRecord {
  const circuit = loadCircuit(process.cwd(), "intent-validity");
  const intentCommitment = commitIntent(intent);
  const binding = intentBindingFields(intent);
  const marginRoot = executor.store.marginMembershipRoot();
  const noteCommitment = hashFields("note-commitment", [intentCommitment]);
  const proof: ProofMeta = {
    circuitId: "intent-validity",
    circuitKey: circuitKey("intent-validity"),
    circuitHash: circuit.sourceHash,
    verifierHash: circuit.verifierHash,
    publicInputHash: hashFields("intent-validity-public", [
      intentCommitment,
      marginRoot,
      noteCommitment,
      intent.noteNullifier,
    ]),
    proofDigest: hashFields("intent-validity-proof", [
      intentCommitment,
      marginRoot,
      noteCommitment,
      intent.noteNullifier,
    ]),
  };
  executor.store.recordProof(proof);
  return {
    batchDigest: binding.batchDigest,
    currentBatch: 1n,
    expiryBatch: 2n,
    intentCommitment,
    marketDigest: binding.marketDigest,
    noteCommitment,
    marginRoot,
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
  noteNullifier = hashFields("nullifier", [id]),
  margin = 12_000n * size,
): RecoveredIntent {
  const intentCommitment = hashFields("intent", [id]);
  return {
    batchId: "matcher-test",
    intentCommitment,
    limitPrice,
    margin,
    marketId: "btc-usd-perp",
    noteNullifier,
    ownerCommitment: hashFields("owner", [id]),
    signedSize: side === "long" ? size : -size,
  };
}
