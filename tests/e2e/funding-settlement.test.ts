import { describe, expect, test } from "bun:test";
import { commitConditionalOrder, hashFields, ownerCommitment } from "@pnlx/crypto";
import { PRICE_SCALE, settleClose } from "@pnlx/market-math";
import type {
  BatchSettlement,
  ConditionalOrderRecord,
  ConditionalOrderWitness,
  Hex,
  LiquidationRecord,
  LiquidationWitness,
  MarketConfig,
  PositionCloseRecord,
  PositionCloseWitness,
  ProofMeta,
} from "@pnlx/protocol-types";
import { createExecutor } from "@/workers/executor/executor.worker";
import type { ExecutorService } from "@/workers/executor/executor.service";
import type { ProverService } from "@/workers/prover/prover.service";
import { createProver } from "@/workers/prover/prover.worker";
import { ConditionalOrdersService } from "@/features/conditional-orders/conditional-orders.service";
import { LiquidationsService } from "@/features/liquidations/liquidations.service";
import { PositionClosesService } from "@/features/position-closes/position-closes.service";

describe("funding settlement enforcement", () => {
  test("builds a real funding settlement proof artifact", () => {
    const prover = createProver();
    const record = prover.proveFundingSettlement({
      appliedAt: 1_000,
      elapsedMs: 3_600_000,
      intervalMs: 3_600_000,
      markPrice: 50_000n * PRICE_SCALE,
      marketId: "btc-usd-perp",
      maxFundingDelta: 1_000n,
      newFundingIndex: 50n,
      oldFundingIndex: 0n,
      premiumRate: 1_000n,
    });

    expect(record.fundingDelta).toBe(50n);
    expect(record.proof.circuitId).toBe("funding-update");
    expect(record.proof.publicInputHash).toMatch(/^0x[0-9a-f]{64}$/);
    const artifact = prover.artifactFor(record.proof);
    expect(artifact?.publicInputsPath).toContain("public_inputs");
    expect(createProver().artifactFor(record.proof)?.publicInputsPath).toBe(artifact?.publicInputsPath);
  });

  test("builds a real negative funding settlement proof artifact", () => {
    const prover = createProver();
    const record = prover.proveFundingSettlement({
      appliedAt: 1_000,
      elapsedMs: 3_600_000,
      intervalMs: 3_600_000,
      markPrice: 50_000n * PRICE_SCALE,
      marketId: "btc-usd-perp",
      maxFundingDelta: 1_000n,
      newFundingIndex: 500n,
      oldFundingIndex: 1_000n,
      premiumRate: -10_000n,
    });

    expect(record.fundingDelta).toBe(-500n);
    expect(record.proof.circuitId).toBe("funding-update");
    expect(record.proof.publicInputHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(prover.artifactFor(record.proof)?.publicInputsPath).toContain("public_inputs");
  });

  test("derives funding credits when the funding index moves backwards", () => {
    const { closeInput, executor } = setupPositionWithConditionalClose();
    executor.store.updateMarket({
      ...executor.store.markets.get(closeInput.marketId)!,
      fundingIndex: 5n,
    });
    let proved = false;
    const service = new PositionClosesService(
      executor,
      {
        provePositionClose(input: PositionCloseWitness): PositionCloseRecord {
          proved = true;
          return {
            closeCommitment: input.closeCommitment,
            marginOutputCommitment: input.marginOutputCommitment,
            marketId: input.marketId,
            markPrice: input.markPrice,
            newPositionCommitment: input.newPositionCommitment,
            newPositionRoot: input.newPositionRoot,
            positionCommitment: input.positionCommitment,
            positionNullifier: input.positionNullifier,
            positionRoot: input.positionRoot,
            proof: proofMeta("close"),
          };
        },
      } as unknown as ProverService,
    );

    expect(() =>
      service.create({ ...closeInput, fundingPayment: 10n }),
    ).toThrow("invalid funding payment");

    service.create({
      ...closeInput,
      fundingPayment: -10n,
      marginOutputAmount: 1_010n,
      newMargin: 1_010n,
    });
    expect(proved).toBe(true);
  });

  test("derives close funding payment from market and position funding indexes", () => {
    const { closeCommitment, closeInput, executor, positionCommitment, positionNullifier } =
      setupPositionWithConditionalClose();
    let proved = false;
    const service = new PositionClosesService(
      executor,
      {
        provePositionClose(input: PositionCloseWitness): PositionCloseRecord {
          proved = true;
          return {
            closeCommitment: input.closeCommitment,
            marginOutputCommitment: input.marginOutputCommitment,
            marketId: input.marketId,
            markPrice: input.markPrice,
            newPositionCommitment: input.newPositionCommitment,
            newPositionRoot: input.newPositionRoot,
            positionCommitment: input.positionCommitment,
            positionNullifier: input.positionNullifier,
            positionRoot: input.positionRoot,
            proof: proofMeta("close"),
          };
        },
      } as unknown as ProverService,
    );

    expect(() => service.create({ ...closeInput, fundingPayment: 9n })).toThrow(
      "invalid funding payment",
    );
    expect(() => service.create({ ...closeInput, markPrice: closeInput.markPrice + 1n })).toThrow(
      "position close mark price mismatch",
    );
    expect(proved).toBe(false);

    const record = service.create(closeInput);

    expect(proved).toBe(true);
    expect(record.closeCommitment).toBe(closeCommitment);
    expect(executor.store.positionLifecycle.get(positionCommitment)?.status).toBe("closed");
    expect(executor.store.positionLifecycle.get(positionCommitment)?.positionNullifier).toBe(
      positionNullifier,
    );
  });

  test("derives liquidation funding payment from market and position funding indexes", () => {
    const { executor, liquidationInput, positionCommitment, positionNullifier, rewardCommitment } =
      setupPositionForLiquidation();
    let proved = false;
    const service = new LiquidationsService(
      executor,
      {
        proveLiquidation(input: LiquidationWitness): LiquidationRecord {
          proved = true;
          return {
            marketId: input.marketId,
            maintenanceRate: input.maintenanceRate,
            markPrice: input.markPrice,
            positionCommitment: input.positionCommitment,
            positionNullifier: input.positionNullifier,
            positionRoot: input.positionRoot,
            proof: proofMeta("liquidation"),
            rewardCommitment: input.rewardCommitment,
          };
        },
      } as unknown as ProverService,
    );

    expect(() => service.create({ ...liquidationInput, fundingPayment: 14n })).toThrow(
      "invalid funding payment",
    );
    expect(() =>
      service.create({ ...liquidationInput, markPrice: liquidationInput.markPrice + 1n }),
    ).toThrow("liquidation mark price mismatch");
    expect(() =>
      service.create({ ...liquidationInput, maintenanceRate: liquidationInput.maintenanceRate + 1n }),
    ).toThrow("liquidation maintenance rate mismatch");
    expect(proved).toBe(false);

    const record = service.create(liquidationInput);

    expect(proved).toBe(true);
    expect(record.rewardCommitment).toBe(rewardCommitment);
    expect(executor.store.positionLifecycle.get(positionCommitment)?.status).toBe("liquidated");
    expect(executor.store.positionLifecycle.get(positionCommitment)?.positionNullifier).toBe(
      positionNullifier,
    );
  });

  test("enforces signed funding payments for short positions", () => {
    const { closeInput, executor } = setupPositionWithConditionalClose();
    let proved = false;
    const service = new PositionClosesService(
      executor,
      {
        provePositionClose(input: PositionCloseWitness): PositionCloseRecord {
          proved = true;
          return {
            closeCommitment: input.closeCommitment,
            marginOutputCommitment: input.marginOutputCommitment,
            marketId: input.marketId,
            markPrice: input.markPrice,
            newPositionCommitment: input.newPositionCommitment,
            newPositionRoot: input.newPositionRoot,
            positionCommitment: input.positionCommitment,
            positionNullifier: input.positionNullifier,
            positionRoot: input.positionRoot,
            proof: proofMeta("close"),
          };
        },
      } as unknown as ProverService,
    );

    expect(() =>
      service.create({ ...closeInput, side: "short", fundingPayment: 10n }),
    ).toThrow("invalid funding payment");
    expect(proved).toBe(false);

    service.create({ ...closeInput, side: "short", fundingPayment: -10n, newMargin: 1_010n });
    expect(proved).toBe(true);
  });

  test("credits margin when funding payment is negative", () => {
    const settlement = settleClose({
      closeSize: 2n,
      entryPrice: 60_000_00000000n,
      fee: 5n,
      fundingPayment: -10n,
      margin: 1_000n,
      markPrice: 60_000_00000000n,
      side: "short",
    });

    expect(settlement.newMargin).toBe(1_005n);
  });

  test("executes a conditional trigger and position close as one workflow", () => {
    const { closeCommitment, closeInput, executor, positionCommitment } =
      setupPositionWithConditionalClose({ triggered: false });
    const trigger = conditionalTriggerFor(closeInput, closeCommitment);
    const calls: string[] = [];
    const service = new ConditionalOrdersService(
      executor,
      {
        proveConditionalClose(input: ConditionalOrderWitness): ConditionalOrderRecord {
          calls.push("trigger-proof");
          return {
            closeCommitment: commitConditionalOrder(input),
            marketId: input.marketId,
            markPrice: input.markPrice,
            positionNullifier: input.positionNullifier,
            proof: proofMeta("conditional"),
          };
        },
        provePositionClose(input: PositionCloseWitness): PositionCloseRecord {
          calls.push("close-proof");
          return {
            closeCommitment: input.closeCommitment,
            marginOutputCommitment: input.marginOutputCommitment,
            marketId: input.marketId,
            markPrice: input.markPrice,
            newPositionCommitment: input.newPositionCommitment,
            newPositionRoot: input.newPositionRoot,
            positionCommitment: input.positionCommitment,
            positionNullifier: input.positionNullifier,
            positionRoot: input.positionRoot,
            proof: proofMeta("close"),
          };
        },
      } as unknown as ProverService,
      testConditionalEnv(false),
      {
        settlePositionClose() {
          calls.push("close-relay");
          return { relays: [] };
        },
        triggerConditionalClose() {
          calls.push("trigger-relay");
          return { relays: [] };
        },
      } as never,
    );

    const result = service.execute({ close: closeInput, trigger });

    expect(result.conditionalClose.closeCommitment).toBe(closeCommitment);
    expect(result.positionClose.closeCommitment).toBe(closeCommitment);
    expect(calls).toEqual(["close-proof", "trigger-proof", "trigger-relay", "close-relay"]);
    expect(executor.store.conditionalCloses.has(closeCommitment)).toBe(true);
    expect(executor.store.positionCloses.has(closeCommitment)).toBe(true);
    expect(executor.store.positionLifecycle.get(positionCommitment)?.status).toBe("closed");
  });

  test("does not trigger a conditional order when the close leg is invalid", () => {
    const { closeCommitment, closeInput, executor } = setupPositionWithConditionalClose({
      triggered: false,
    });
    const trigger = conditionalTriggerFor(closeInput, closeCommitment);
    const calls: string[] = [];
    const service = new ConditionalOrdersService(
      executor,
      {
        proveConditionalClose() {
          calls.push("trigger-proof");
          throw new Error("unexpected trigger proof");
        },
        provePositionClose() {
          calls.push("close-proof");
          throw new Error("unexpected close proof");
        },
      } as unknown as ProverService,
      testConditionalEnv(false),
    );

    expect(() =>
      service.execute({
        close: { ...closeInput, markPrice: closeInput.markPrice + 1n },
        trigger: { ...trigger, markPrice: closeInput.markPrice + 1n },
      }),
    ).toThrow("position close mark price mismatch");
    expect(calls).toEqual([]);
    expect(executor.store.conditionalCloses.has(closeCommitment)).toBe(false);
    expect(executor.store.positionCloses.has(closeCommitment)).toBe(false);
  });

  test("does not locally index conditional orders without a submitted on-chain relay when required", () => {
    const { closeCommitment, closeInput, executor } = setupPositionWithConditionalClose({
      triggered: false,
    });
    executor.store.conditionalOrders.delete(closeCommitment);
    const trigger = conditionalTriggerFor(closeInput, closeCommitment);
    const calls: string[] = [];
    const service = new ConditionalOrdersService(
      executor,
      {
        proveConditionalClose(input: ConditionalOrderWitness): ConditionalOrderRecord {
          calls.push("trigger-proof");
          return {
            closeCommitment: commitConditionalOrder(input),
            marketId: input.marketId,
            markPrice: input.markPrice,
            positionNullifier: input.positionNullifier,
            proof: proofMeta("conditional"),
          };
        },
      } as unknown as ProverService,
      testConditionalEnv(true),
      {
        enabled: true,
        registerConditionalOrder() {
          calls.push("register-relay");
          return { relays: [unsubmittedRelay("register")] };
        },
        triggerConditionalClose() {
          calls.push("trigger-relay");
          return { relays: [unsubmittedRelay("trigger")] };
        },
      } as never,
    );

    expect(() =>
      service.register({
        closeCommitment,
        marketId: closeInput.marketId,
        positionNullifier: closeInput.positionNullifier,
      }),
    ).toThrow("register transaction was not submitted");
    expect(executor.store.conditionalOrders.has(closeCommitment)).toBe(false);

    executor.store.addConditionalOrder({
      closeCommitment,
      marketId: closeInput.marketId,
      positionNullifier: closeInput.positionNullifier,
    });
    expect(() => service.trigger(trigger)).toThrow("trigger transaction was not submitted");
    expect(calls).toEqual(["register-relay", "trigger-proof", "trigger-relay"]);
    expect(executor.store.conditionalCloses.has(closeCommitment)).toBe(false);
  });
});

function testConditionalEnv(required: boolean) {
  return { conditionalOrdersOnchainRequired: required } as never;
}

function unsubmittedRelay(functionName: string) {
  return {
    functionName,
    kind: "conditional-order",
    mode: "local",
    payloadDigest: hashFields("payload", [functionName]),
    relayId: hashFields("relay", [functionName]),
    submitted: false,
    submittedAt: Date.now(),
  };
}

function setupPositionWithConditionalClose(options: { triggered?: boolean } = {}): {
  closeCommitment: Hex;
  closeInput: PositionCloseWitness;
  executor: ExecutorService;
  positionCommitment: Hex;
  positionNullifier: Hex;
} {
  const executor = createExecutor();
  const market: MarketConfig = {
    fundingIndex: 15n,
    initialMarginRate: 100_000n,
    maintenanceMarginRate: 50_000n,
    marketId: "btc-usd-perp",
    maxLeverage: 10n,
    oraclePrice: 60_000_00000000n,
  };
  const settlementProof = proofMeta("settlement");
  const closeProof = proofMeta("close");
  const triggered = options.triggered ?? true;
  const owner = ownerCommitment("GFUNDING");
  const positionCommitment = hashFields("position", ["funding"]);
  const positionNullifier = hashFields("position-nullifier", ["funding"]);
  const closeCommitment = commitConditionalOrder({
    kind: "take-profit",
    marketId: market.marketId,
    markPrice: market.oraclePrice,
    positionNullifier,
    reduceOnly: true,
    salt: "funding",
    side: "long",
    size: 2n,
    triggerPrice: market.oraclePrice - 1n,
  });
  const newPositionCommitment = hashFields("position", ["funding-closed"]);
  const marginOutputCommitment = hashFields("margin-output", ["funding"]);

  executor.addMarket(market);
  executor.store.recordProof(settlementProof);
  if (triggered) {
    executor.store.recordProof(closeProof);
  }
  const settlement: BatchSettlement = {
    aggregateVolume: 1n,
    batchId: "funding-batch",
    fillCount: 1,
    matchTranscriptDigest: hashFields("match-transcript", ["funding"]),
    marginChangeCommitments: [],
    marketId: market.marketId,
    newCommitments: [positionCommitment],
    newRoot: executor.store.positionMembershipRootWith(positionCommitment),
    oldRoot: executor.store.positionMembershipRoot(),
    openInterestDelta: 1n,
    orderUpdates: [],
    proof: settlementProof,
    residualSize: 0n,
    settlementDigest: hashFields("settlement", ["funding"]),
    spentNullifiers: [],
  };
  executor.store.addSettlement(settlement, [
    {
      batchId: settlement.batchId,
      marketId: market.marketId,
      openedAt: 1,
      ownerCommitment: owner,
      positionCommitment,
      positionNullifier,
      settlementDigest: settlement.settlementDigest,
      sourceIntentCommitment: hashFields("intent", ["funding"]),
      status: "open",
      updatedAt: 1,
    },
  ]);
  executor.store.addConditionalOrder({
    closeCommitment,
    marketId: market.marketId,
    positionNullifier,
  });
  if (triggered) {
    executor.store.addConditionalClose({
      closeCommitment,
      marketId: market.marketId,
      markPrice: market.oraclePrice,
      positionNullifier,
      proof: closeProof,
    });
  }

  const newPositionRoot = executor.store.positionMembershipRootWith(newPositionCommitment);
  return {
    closeCommitment,
    closeInput: {
      blinding: hashFields("blinding", ["funding"]),
      closeCommitment,
      closeSize: 2n,
      entryPrice: market.oraclePrice,
      fee: 0n,
      fundingIndex: 10n,
      fundingPayment: 10n,
      margin: 1_000n,
      marginOutputAmount: 990n,
      marginOutputCommitment,
      marginOutputAssetDigest: hashFields("asset", ["usdc"]),
      marginOutputBlinding: hashFields("margin-output-blinding", ["funding"]),
      marginOutputRhoDigest: hashFields("margin-output-rho", ["funding"]),
      marketDigest: hashFields("market", [market.marketId]),
      marketId: market.marketId,
      markPrice: market.oraclePrice,
      newMargin: 990n,
      newPositionBlinding: hashFields("new-position-blinding", ["funding"]),
      newPositionCommitment,
      newPositionRhoDigest: hashFields("new-position-rho", ["funding"]),
      newPositionRoot,
      ownerDigest: hashFields("owner", [owner]),
      pathIndices: Array(8).fill(false),
      pathSiblings: Array(8).fill("0x0" as Hex),
      positionCommitment,
      positionNullifier,
      positionRoot: executor.store.positionMembershipRoot(),
      remainingMargin: 0n,
      rhoDigest: hashFields("rho", ["funding"]),
      side: "long",
      size: 2n,
      spendSecretDigest: hashFields("spend", ["funding"]),
    },
    executor,
    positionCommitment,
    positionNullifier,
  };
}

function conditionalTriggerFor(
  closeInput: PositionCloseWitness,
  closeCommitment: Hex,
): ConditionalOrderWitness {
  const trigger = {
    kind: "take-profit" as const,
    marketId: closeInput.marketId,
    markPrice: closeInput.markPrice,
    positionNullifier: closeInput.positionNullifier,
    reduceOnly: true,
    salt: "funding",
    side: closeInput.side,
    size: closeInput.closeSize,
    triggerPrice: closeInput.markPrice - 1n,
  };
  if (commitConditionalOrder(trigger) !== closeCommitment) {
    throw new Error("test conditional trigger commitment mismatch");
  }
  return trigger;
}

function setupPositionForLiquidation(): {
  executor: ExecutorService;
  liquidationInput: LiquidationWitness;
  positionCommitment: Hex;
  positionNullifier: Hex;
  rewardCommitment: Hex;
} {
  const executor = createExecutor();
  const market: MarketConfig = {
    fundingIndex: 17n,
    initialMarginRate: 100_000n,
    maintenanceMarginRate: 50_000n,
    marketId: "eth-usd-perp",
    maxLeverage: 10n,
    oraclePrice: 3_000_00000000n,
  };
  const settlementProof = proofMeta("liquidation-settlement");
  const liquidationProof = proofMeta("liquidation");
  const owner = ownerCommitment("GLIQUIDATION");
  const positionCommitment = hashFields("position", ["liquidation"]);
  const positionNullifier = hashFields("position-nullifier", ["liquidation"]);
  const rewardCommitment = hashFields("liquidation-reward", ["liquidation"]);

  executor.addMarket(market);
  executor.store.recordProof(settlementProof);
  executor.store.recordProof(liquidationProof);
  const settlement: BatchSettlement = {
    aggregateVolume: 3n,
    batchId: "liquidation-batch",
    fillCount: 1,
    matchTranscriptDigest: hashFields("match-transcript", ["liquidation"]),
    marginChangeCommitments: [],
    marketId: market.marketId,
    newCommitments: [positionCommitment],
    newRoot: executor.store.positionMembershipRootWith(positionCommitment),
    oldRoot: executor.store.positionMembershipRoot(),
    openInterestDelta: 3n,
    orderUpdates: [],
    proof: settlementProof,
    residualSize: 0n,
    settlementDigest: hashFields("settlement", ["liquidation"]),
    spentNullifiers: [],
  };
  executor.store.addSettlement(settlement, [
    {
      batchId: settlement.batchId,
      marketId: market.marketId,
      openedAt: 2,
      ownerCommitment: owner,
      positionCommitment,
      positionNullifier,
      settlementDigest: settlement.settlementDigest,
      sourceIntentCommitment: hashFields("intent", ["liquidation"]),
      status: "open",
      updatedAt: 2,
    },
  ]);

  return {
    executor,
    liquidationInput: {
      blinding: hashFields("blinding", ["liquidation"]),
      entryPrice: 3_400_00000000n,
      fundingIndex: 12n,
      fundingPayment: 15n,
      maintenanceRate: market.maintenanceMarginRate,
      margin: 500n,
      marketDigest: hashFields("market", [market.marketId]),
      marketId: market.marketId,
      markPrice: market.oraclePrice,
      ownerDigest: hashFields("owner", [owner]),
      pathIndices: Array(8).fill(false),
      pathSiblings: Array(8).fill("0x0" as Hex),
      positionCommitment,
      positionNullifier,
      positionRoot: executor.store.positionMembershipRoot(),
      rewardCommitment,
      rhoDigest: hashFields("rho", ["liquidation"]),
      side: "long",
      size: 3n,
      spendSecretDigest: hashFields("spend", ["liquidation"]),
    },
    positionCommitment,
    positionNullifier,
    rewardCommitment,
  };
}

function proofMeta(label: string): ProofMeta {
  return {
    circuitHash: hashFields("circuit-hash", [label]),
    circuitId:
      label === "close"
        ? "position-close"
        : label === "conditional"
          ? "conditional-close"
          : label === "liquidation"
            ? "liquidation-check"
            : "batch-match",
    circuitKey: hashFields("circuit-key", [label]),
    proofDigest: hashFields("proof-digest", [label]),
    publicInputHash: hashFields("public-input", [label]),
    verifierHash: hashFields("verifier", [label]),
  };
}
