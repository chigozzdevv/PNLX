import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { digestToFieldHex, hashFields, intentOwnerCommitmentField, ownerCommitment } from "@pnlx/crypto";
import type {
  BatchSettlement,
  Hex,
  IntentRecord,
  MarketConfig,
  PositionLifecycleRecord,
  ProofMeta,
} from "@pnlx/protocol-types";
import { FileProtocolStore } from "@/shared/state/persistent-store";
import { createIndexer } from "@/workers/indexer/indexer.worker";
import { assertBatchSettlementCapacity } from "@/shared/protocol/batch-settlement-proof";

describe("public and owner indexer", () => {
  test("returns recorded capacity counts only for the owner's failed batch", () => {
    const storePath = join(mkdtempSync(join(tmpdir(), "pnlx-capacity-indexer-")), "protocol-store.json");
    const store = new FileProtocolStore(storePath);
    const owner = ownerCommitment("GCAPACITY");
    const record = intentRecord("capacity", "xlm-usd-perp", owner, store.marginMembershipRoot(), proofMeta("capacity"));
    store.recordProof(record.proof);
    store.addIntent(record);
    let reason = "";
    try {
      assertBatchSettlementCapacity({
        orderUpdates: Array(6).fill({ intentCommitment: "0x1", status: "filled" }),
        newCommitments: Array(10).fill("0x1"),
        marginChangeCommitments: [],
        spentNullifiers: Array(6).fill("0x1"),
      }, 5);
    } catch (error) { reason = (error as Error).message; }
    const run = {
      batchId: record.batchId, marketId: record.marketId, phase: "proving" as const,
      runId: hashFields("capacity-run", [record.intentCommitment]),
      startedAt: 100, completedAt: 200, status: "failed" as const, reason: `proving: ${reason}`,
    };
    store.addBatchExecutionRun(run, [record.intentCommitment]);
    const reloaded = new FileProtocolStore(storePath);
    const indexer = createIndexer(reloaded);
    expect(indexer.ordersFor(owner)[0].matching.capacity).toEqual({
      limit: 8, filledIntents: 6, positionOutputs: 10, marginChangeOutputs: 0, notesToSpend: 6, matchedExecutions: 5,
    });
    expect(indexer.ordersFor(ownerCommitment("GOTHER"))).toEqual([]);
    reloaded.upsertBatchExecutionRun({ ...run, status: "running", completedAt: undefined }, [record.intentCommitment]);
    expect(indexer.ordersFor(owner)[0].matching.capacity).toBeUndefined();
  });

  test("rebuilds market aggregates and owner order status from the persistent protocol store", () => {
    const storePath = join(mkdtempSync(join(tmpdir(), "pnlx-indexer-")), "protocol-store.json");
    const store = new FileProtocolStore(storePath);
    const proof = proofMeta("indexer-proof");
    const market: MarketConfig = {
      marketId: "btc-usd-perp",
      oraclePrice: 60_000_00000000n,
      maxLeverage: 10n,
      initialMarginRate: 100_000n,
      maintenanceMarginRate: 50_000n,
      fundingIndex: 12n,
    };
    const owner = ownerCommitment("GACCOUNT");
    const filled = intentRecord("filled", market.marketId, owner, store.marginMembershipRoot(), proof);
    const partial = intentRecord("partial", market.marketId, owner, store.marginMembershipRoot(), proof);
    const open = intentRecord("open", market.marketId, owner, store.marginMembershipRoot(), proof);
    const settlement = settlementRecord(market.marketId, filled, partial, proof);
    const positionOpenings = lifecycleOpenings(settlement, owner, filled, partial);
    const closeProof = proofMeta("indexer-close-proof");
    const closeCommitment = hashFields("conditional-close", ["filled"]);
    const closeProofTxHash = hashFields("tx", ["close-proof", filled.intentCommitment]);
    const closeSettlementTxHash = hashFields("tx", ["close-settlement", filled.intentCommitment]);
    const marginOutputCommitment = hashFields("margin-output", ["filled"]);
    const newPositionCommitment = hashFields("position", ["filled-closed"]);

    store.recordProof(proof);
    store.recordProof(closeProof);
    store.addMarket(market);
    store.addIntent(filled);
    store.addIntent(partial);
    store.addIntent(open);
    const submissionTxHash = hashFields("tx", [filled.intentCommitment]);
    store.updateIntentSubmissionTxHash(filled.intentCommitment, submissionTxHash);
    const settlementRunId = hashFields("batch-run", [settlement.settlementDigest]);
    const settlementStartedAt = Date.now() - 2_000;
    store.addBatchExecutionRun({
      batchId: settlement.batchId,
      marketId: market.marketId,
      phase: "settlement-commit",
      runId: settlementRunId,
      startedAt: settlementStartedAt,
      status: "running",
      updatedAt: settlementStartedAt,
    }, [filled.intentCommitment, partial.intentCommitment]);
    store.addSettlement(settlement, positionOpenings);
    store.upsertBatchExecutionRun({
      batchId: settlement.batchId,
      completedAt: settlementStartedAt + 1_000,
      marketId: market.marketId,
      runId: settlementRunId,
      settlementDigest: settlement.settlementDigest,
      startedAt: settlementStartedAt,
      status: "settled",
    }, [filled.intentCommitment, partial.intentCommitment]);
    const enrichedSettlement = store.updateSettlementTransactions(settlement.settlementDigest, {
      boundlessRequestId: hashFields("boundless-request", [filled.intentCommitment]),
      proofVerificationTxHash: hashFields("tx", ["proof-verification", filled.intentCommitment]),
      settlementTxHash: hashFields("tx", ["settlement", filled.intentCommitment]),
    });
    store.addBatchExecutionRun({
      batchId: open.batchId,
      marketId: market.marketId,
      phase: "proving",
      runId: hashFields("batch-run", [open.intentCommitment]),
      startedAt: Date.now(),
      status: "running",
      updatedAt: Date.now(),
    }, [open.intentCommitment]);
    const provingRun = [...store.batchExecutionRuns.values()].find(
      (run) => run.phase === "proving" && run.status === "running",
    );
    if (!provingRun) throw new Error("expected proving run");
    store.addBatchExecutionRun({
      batchId: open.batchId,
      completedAt: provingRun.startedAt + 20_000,
      marketId: market.marketId,
      phase: "matcher",
      reason: "matcher: earlier request timed out",
      runId: hashFields("batch-run", [open.intentCommitment, "older-failure"]),
      startedAt: provingRun.startedAt - 1_000,
      status: "failed",
    });
    const unrelatedRunId = hashFields("batch-run", ["unrelated"]);
    store.addBatchExecutionRun({
      batchId: "unrelated-batch",
      marketId: market.marketId,
      phase: "matcher",
      runId: unrelatedRunId,
      startedAt: provingRun.startedAt + 1_000,
      status: "running",
      updatedAt: provingRun.startedAt + 1_000,
    });
    store.addConditionalOrder({
      closeCommitment,
      marketId: market.marketId,
      positionNullifier: positionOpenings[0].positionNullifier,
    });
    store.addConditionalClose({
      closeCommitment,
      marketId: market.marketId,
      markPrice: market.oraclePrice,
      positionNullifier: positionOpenings[0].positionNullifier,
      proof: closeProof,
    });
    store.addPositionClose({
      closeCommitment,
      marginOutputCommitment,
      marketId: market.marketId,
      markPrice: market.oraclePrice,
      newPositionCommitment,
      positionCommitment: positionOpenings[0].positionCommitment,
      positionNullifier: positionOpenings[0].positionNullifier,
      positionRoot: store.positionMembershipRoot(),
      proof: closeProof,
      proofVerificationTxHash: closeProofTxHash,
      settlementTxHash: closeSettlementTxHash,
    });
    store.addAccountEvent({
      ciphertext: "base64:client-encrypted-order-history",
      createdAt: 1,
      dataCommitment: hashFields("account-event-data", ["filled"]),
      eventId: hashFields("account-event", ["filled"]),
      ownerCommitment: owner,
    });

    const reloaded = new FileProtocolStore(storePath);
    const indexer = createIndexer(reloaded);
    const publicState = indexer.snapshot();
    const activities = indexer.activitiesFor(owner);
    const orders = indexer.ordersFor(owner);
    const positions = indexer.positionsFor(owner);

    expect(publicState.marketCount).toBe(1);
    expect(publicState.accountEventCount).toBe(1);
    expect(publicState.positionLifecycleCount).toBe(2);
    expect(publicState.markets).toEqual([
      {
        aggregateVolume: "1",
        conditionalCloseCount: 1,
        conditionalOrderCount: 1,
        fundingIndex: "12",
        initialMarginRate: "100000",
        liquidationCount: 0,
        maintenanceMarginRate: "50000",
        marketId: market.marketId,
        maxLeverage: "10",
        oraclePrice: "6000000000000",
        pendingIntentCount: 2,
        positionCloseCount: 1,
        settledBatchCount: 1,
      },
    ]);
    expect(Object.fromEntries(orders.map((order) => [order.intentCommitment, order.status]))).toEqual({
      [filled.intentCommitment]: "filled",
      [partial.intentCommitment]: "partially-filled",
      [open.intentCommitment]: "open",
    });
    expect(orders.find((order) => order.intentCommitment === filled.intentCommitment))
      .toMatchObject({
        createdAt: expect.any(Number),
        isResidual: false,
        matchingPayloadCommitment: filled.matchingPayloadCommitment,
        submissionTxHash,
        updatedAt: expect.any(Number),
      });
    expect(orders.find((order) => order.intentCommitment === open.intentCommitment)?.matching)
      .toMatchObject({
        message: "Generating batch proof",
        phase: "proving",
        state: "proving",
        status: "running",
      });
    expect(orders.find((order) => order.intentCommitment === partial.intentCommitment)?.residualCommitment)
      .toMatch(/^0x[0-9a-f]{64}$/);
    expect(orders.find((order) => order.intentCommitment === partial.intentCommitment)?.matching)
      .toMatchObject({
        message: "Batch settled; refreshing position state",
        runId: settlementRunId,
        state: "settled",
        status: "settled",
      });
    expect(positions).toHaveLength(2);
    expect(Object.fromEntries(positions.map((position) => [position.sourceIntentCommitment, position.status]))).toEqual({
      [filled.intentCommitment]: "closed",
      [partial.intentCommitment]: "open",
    });
    expect(positions.find((position) => position.sourceIntentCommitment === filled.intentCommitment))
      .toMatchObject({
        boundlessRequestId: enrichedSettlement.proof.boundlessRequestId,
        closeCommitment,
        marginOutputCommitment,
        newPositionCommitment,
        lifecycleKind: "close",
        lifecycleProofDigest: closeProof.proofDigest,
        lifecycleProofTxHash: closeProofTxHash,
        lifecycleTxHash: closeSettlementTxHash,
        proofDigest: enrichedSettlement.proof.proofDigest,
        proofVerificationTxHash: enrichedSettlement.proofVerificationTxHash,
        settlementTxHash: enrichedSettlement.settlementTxHash,
      });
    expect(JSON.stringify(positions)).not.toContain("positionNullifier");
    expect(activities.map((activity) => activity.kind).sort()).toEqual([
      "account-event",
      "order",
      "order",
      "order",
      "position",
      "position",
      "position-close",
    ]);
    expect(activities.find((activity) => activity.kind === "position"))
      .toMatchObject({
        batchId: settlement.batchId,
        marketId: market.marketId,
        proofTxHash: enrichedSettlement.proofVerificationTxHash,
        txHash: enrichedSettlement.settlementTxHash,
      });
    expect(activities.find((activity) => activity.kind === "position-close"))
      .toMatchObject({
        id: closeCommitment,
        proofDigest: closeProof.proofDigest,
        proofTxHash: closeProofTxHash,
        status: "closed",
        txHash: closeSettlementTxHash,
      });
    expect(JSON.stringify(activities)).not.toContain("positionNullifier");
  });
});

function proofMeta(label: string): ProofMeta {
  return {
    circuitHash: hashFields("circuit-hash", [label]),
    circuitId: "batch-match",
    circuitKey: hashFields("circuit-key", [label]),
    proofDigest: hashFields("proof-digest", [label]),
    publicInputHash: hashFields("public-input", [label]),
    verifierHash: hashFields("verifier", [label]),
  };
}

function intentRecord(
  label: string,
  marketId: string,
  owner: `0x${string}`,
  marginRoot: `0x${string}`,
  proof: ProofMeta,
): IntentRecord {
  return {
    batchDigest: digestToFieldHex("batch:batch-indexer"),
    batchId: "batch-indexer",
    intentCommitment: hashFields("intent", [label]),
    marketDigest: digestToFieldHex(`market:${marketId}`),
    marginRoot,
    marketId,
    noteChangeCommitment: "0x0",
    noteNullifier: hashFields("note-nullifier", [label]),
    ownerCommitment: owner,
    ownerCommitmentField: intentOwnerCommitmentField(owner),
    proof,
    matchingPayloadCommitment: hashFields("matching-payload", [label]),
  };
}

function settlementRecord(
  marketId: string,
  filled: IntentRecord,
  partial: IntentRecord,
  proof: ProofMeta,
): BatchSettlement {
  return {
    aggregateVolume: 2n,
    batchId: filled.batchId,
    fillCount: 2,
    matchTranscriptDigest: hashFields("match-transcript", [filled.intentCommitment, partial.intentCommitment]),
    marginChangeCommitments: [],
    marketId,
    newCommitments: [hashFields("position", ["a"]), hashFields("position", ["b"])],
    openInterestDelta: 2n,
    orderUpdates: [
      {
        intentCommitment: filled.intentCommitment,
        status: "filled",
      },
      {
        intentCommitment: partial.intentCommitment,
        residualCommitment: hashFields("residual-order", [partial.intentCommitment]),
        status: "partially-filled",
      },
    ],
    proof,
    residualSize: 0n,
    settlementDigest: hashFields("settlement", [filled.intentCommitment, partial.intentCommitment]),
    spentNullifiers: [filled.noteNullifier, partial.noteNullifier],
  };
}

function lifecycleOpenings(
  settlement: BatchSettlement,
  owner: Hex,
  filled: IntentRecord,
  partial: IntentRecord,
): PositionLifecycleRecord[] {
  const now = 1_710_000_000_000;
  return [
    {
      batchId: settlement.batchId,
      marketId: settlement.marketId,
      openedAt: now,
      ownerCommitment: owner,
      positionCommitment: settlement.newCommitments[0],
      positionNullifier: hashFields("position-nullifier", ["filled"]),
      settlementDigest: settlement.settlementDigest,
      sourceIntentCommitment: filled.intentCommitment,
      status: "open",
      updatedAt: now,
    },
    {
      batchId: settlement.batchId,
      marketId: settlement.marketId,
      openedAt: now + 1,
      ownerCommitment: owner,
      positionCommitment: settlement.newCommitments[1],
      positionNullifier: hashFields("position-nullifier", ["partial"]),
      settlementDigest: settlement.settlementDigest,
      sourceIntentCommitment: partial.intentCommitment,
      status: "open",
      updatedAt: now + 1,
    },
  ];
}
