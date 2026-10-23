import { describe, expect, test } from "bun:test";
import { commitConditionalOrder, digestToFieldHex, hashFields, ownerCommitment } from "@pnlx/crypto";
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
  PairedPositionCloseRecord,
  PrivateMatchIntent,
  PositionCloseWitness,
  ProofMeta,
} from "@pnlx/protocol-types";
import { createExecutor } from "@/workers/executor/executor.worker";
import { FEE_CONFIG_HASH } from "@/shared/protocol/fee-config";
import type { ExecutorService } from "@/workers/executor/executor.service";
import type { ProverService } from "@/workers/prover/prover.service";
import { createProver } from "@/workers/prover/prover.worker";
import { ConditionalOrdersService } from "@/features/conditional-orders/conditional-orders.service";
import { LiquidationsService } from "@/features/liquidations/liquidations.service";
import { PositionClosesService } from "@/features/position-closes/position-closes.service";
import { hostedPositionCloseWitness } from "@/features/position-closes/paired-position-witness";
import { BatchMatcherService } from "@/workers/batch-matcher/batch-matcher.service";
import { prepareRisc0SettlementDraft } from "@/workers/risc0-matcher/risc0-proof";

describe("funding settlement enforcement", () => {
  test("builds a real funding settlement proof artifact", () => {
    const prover = createProver();
    const record = prover.proveFundingSettlement({
      appliedAt: 1_000,
      elapsedMs: 3_600_000,
      intervalMs: 3_600_000,
      markPrice: 50_000n * PRICE_SCALE,
      marketId: "btc-usd-perp",
      maxFundingDelta: 100n * PRICE_SCALE,
      newFundingIndex: 50n * PRICE_SCALE,
      oldFundingIndex: 0n,
      premiumRate: 1_000n,
    });

    expect(record.fundingDelta).toBe(50n * PRICE_SCALE);
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
      maxFundingDelta: 1_000n * PRICE_SCALE,
      newFundingIndex: 500n * PRICE_SCALE,
      oldFundingIndex: 1_000n * PRICE_SCALE,
      premiumRate: -10_000n,
    });

    expect(record.fundingDelta).toBe(-500n * PRICE_SCALE);
    expect(record.proof.circuitId).toBe("funding-update");
    expect(record.proof.publicInputHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(prover.artifactFor(record.proof)?.publicInputsPath).toContain("public_inputs");
  });

  test("derives funding credits when the funding index moves backwards", () => {
    const { closeInput, executor } = setupPositionWithConditionalClose();
    executor.store.updateMarket({
      ...executor.store.markets.get(closeInput.marketId)!,
      fundingIndex: 5n * PRICE_SCALE,
    });
    let proved = false;
    const service = new PositionClosesService(
      executor,
      {
        provePositionClose(input: PositionCloseWitness): PositionCloseRecord {
          proved = true;
          return {
      currentFundingIndex: input.currentFundingIndex,
            closeCommitment: input.closeCommitment,
            marginOutputCommitment: input.marginOutputCommitment,
            marketId: input.marketId,
            markPrice: input.markPrice,
            newPositionCommitment: input.newPositionCommitment,
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
      currentFundingIndex: input.currentFundingIndex,
            closeCommitment: input.closeCommitment,
            marginOutputCommitment: input.marginOutputCommitment,
            marketId: input.marketId,
            markPrice: input.markPrice,
            newPositionCommitment: input.newPositionCommitment,
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

  test("uses the live on-chain mark price for close context and validation", () => {
    const {
      closeInput,
      executor,
      ownerCommitment: owner,
      positionCommitment,
    } = setupPairedConditionalClose();
    const liveMarkPrice = closeInput.markPrice + 25n;
    const service = new PositionClosesService(
      executor,
      {} as ProverService,
      {
        enabled: true,
        marketFundingIndex() { return closeInput.currentFundingIndex; },
        marketPrice(marketId: string) {
          expect(marketId).toBe(closeInput.marketId);
          return liveMarkPrice;
        },
      } as never,
    );

    const context = service.context({
      ownerCommitment: owner,
      positionCommitment,
    });

    expect(context.market.markPrice).toBe(liveMarkPrice.toString());
    expect(() => service.validate(closeInput)).toThrow("position close mark price mismatch");
  });

  test("persists manual close proof and settlement transaction evidence", () => {
    const { closeInput, executor } = setupPositionWithConditionalClose();
    const proofTxHash = hashFields("tx", ["manual-close-proof"]);
    const settlementTxHash = hashFields("tx", ["manual-close-settlement"]);
    const service = new PositionClosesService(
      executor,
      {
        provePositionClose(input: PositionCloseWitness): PositionCloseRecord {
          return {
      currentFundingIndex: input.currentFundingIndex,
            closeCommitment: input.closeCommitment,
            marginOutputCommitment: input.marginOutputCommitment,
            marketId: input.marketId,
            markPrice: input.markPrice,
            newPositionCommitment: input.newPositionCommitment,
            positionCommitment: input.positionCommitment,
            positionNullifier: input.positionNullifier,
            positionRoot: input.positionRoot,
            proof: proofMeta("manual-close-evidence"),
          };
        },
      } as unknown as ProverService,
      {
        settleManualPositionClose() {
          return {
            relays: [
              submittedRelay("verify_and_record", proofTxHash),
              submittedRelay("settle_manual", settlementTxHash),
            ],
          };
        },
      } as never,
    );

    const record = service.createManual(closeInput);

    expect(record).toMatchObject({
      proofVerificationTxHash: proofTxHash,
      settlementTxHash,
      txHash: settlementTxHash,
    });
    expect(executor.store.positionCloses.get(record.closeCommitment)).toMatchObject({
      proofVerificationTxHash: proofTxHash,
      settlementTxHash,
    });
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
      currentFundingIndex: input.currentFundingIndex,
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
      currentFundingIndex: input.currentFundingIndex,
            closeCommitment: input.closeCommitment,
            marginOutputCommitment: input.marginOutputCommitment,
            marketId: input.marketId,
            markPrice: input.markPrice,
            newPositionCommitment: input.newPositionCommitment,
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

  test("executes a conditional trigger and position close as one workflow", async () => {
    const { closeCommitment, closeInput, executor, positionCommitment } =
      setupPairedConditionalClose({ triggered: false });
    const trigger = conditionalTriggerFor(closeInput, closeCommitment);
    const calls: string[] = [];
    const settled = new Set<Hex>();
    const appendIndices = new Map<Hex, number>();
    const settlementTxHash = hashFields("tx", ["conditional-pair"]);
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
        async provePositionClosePairAsync(witnesses: [PositionCloseWitness, PositionCloseWitness]): Promise<PairedPositionCloseRecord> {
          calls.push("pair-proof");
          const proof = proofMeta("position-close-pair");
          return { marketId: witnesses[0].marketId, assetDigest: witnesses[0].marginOutputAssetDigest,
            markPrice: witnesses[0].markPrice, currentFundingIndex: witnesses[0].currentFundingIndex,
            maintenanceRate: 50_000n, liquidation: false, positionRoot: witnesses[0].positionRoot,
            positions: [{ ...witnesses[0], proof }, { ...witnesses[1], proof }], proof };
        },
      } as unknown as ProverService,
      testConditionalEnv(false),
      {
        enabled: true,
        marketPrice() { return closeInput.markPrice; },
        async marketPriceAsync() { return closeInput.markPrice; },
        async marketFundingIndexAsync() { return closeInput.currentFundingIndex; },
        async isPositionCloseSettledAsync(commitment: Hex) { return settled.has(commitment); },
        async positionCloseAppendIndexAsync(commitment: Hex) { return appendIndices.get(commitment)!; },
        async positionPairTransactionStatus() { return "SUCCESS"; },
        async settleJournaledPositionPair(pair: PairedPositionCloseRecord, conditional: boolean,
          beforeSubmit: (prepared: { txHash: Hex; xdr: string }) => Promise<void>) {
          calls.push("pair-relay");
          expect(conditional).toBe(true);
          expect(executor.store.positionCloses.size).toBe(0);
          await beforeSubmit({ txHash: settlementTxHash, xdr: "signed-pair-envelope" });
          expect(executor.store.pendingPairedCloses.get(pair.positions[0].closeCommitment)?.settlementTxHash).toBe(settlementTxHash);
          const appendAt = executor.store.positionCommitments.size;
          for (const [index, record] of pair.positions.entries()) {
            appendIndices.set(record.closeCommitment, appendAt + index);
            settled.add(record.closeCommitment);
          }
          return { relays: [submittedRelay("verify_and_record", hashFields("tx", ["conditional-pair-proof"])),
            submittedRelay("settle_pair_conditional_proven", settlementTxHash)] };
        },
        triggerConditionalClose() {
          calls.push("trigger-relay");
          return { relays: [] };
        },
      } as never,
    );

    const result = await service.execute({ close: closeInput, trigger });

    expect(result.conditionalClose.closeCommitment).toBe(closeCommitment);
    expect(result.positionClose.closeCommitment).toBe(closeCommitment);
    expect(calls).toEqual(["trigger-proof", "trigger-relay", "pair-proof", "pair-relay"]);
    expect(executor.store.positionCloses.size).toBe(2);
    expect([...executor.store.pendingPairedCloses.values()].filter((run) => !run.retired)).toHaveLength(0);
    expect([...executor.store.pendingPairedCloses.values()].some((run) => run.retiredReconciled)).toBe(true);
    expect([...executor.store.positionCloses.values()].every((position) => position.settlementTxHash === settlementTxHash)).toBe(true);
    expect([...executor.store.positionLifecycle.values()].every((position) => position.status === "closed")).toBe(true);
    expect(executor.store.conditionalCloses.has(closeCommitment)).toBe(true);
    expect(executor.store.positionCloses.has(closeCommitment)).toBe(true);
    expect(executor.store.positionLifecycle.get(positionCommitment)?.status).toBe("closed");
  });

  test("does not trigger a conditional order when the close leg is invalid", async () => {
    const { closeCommitment, closeInput, executor } = setupPairedConditionalClose({
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

    await expect(
      service.execute({
        close: { ...closeInput, markPrice: closeInput.markPrice + 1n },
        trigger: { ...trigger, markPrice: closeInput.markPrice + 1n },
      }),
    ).rejects.toThrow("conditional close mark price mismatch");
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
        marketPrice() {
          return closeInput.markPrice;
        },
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

function submittedRelay(functionName: string, txHash: Hex) {
  return {
    ...unsubmittedRelay(functionName),
    submitted: true,
    txHash,
  };
}

function setupPairedConditionalClose(options: { triggered?: boolean } = {}) {
  const executor = createExecutor();
  const key = (label: string) => digestToFieldHex(`funding-pair-fixture:${label}`);
  const market: MarketConfig = { marketId: "btc-usd-perp", oraclePrice: 100_000_000n, fundingIndex: 0n,
    initialMarginRate: 100_000n, maintenanceMarginRate: 50_000n, maxLeverage: 10n };
  executor.addMarket(market);
  const intents: PrivateMatchIntent[] = [1n, -1n].map((side, index) => ({ batchId: "funding-pair",
    marketId: market.marketId, intentCommitment: key(`intent-${index}`), noteNullifier: key(`note-${index}`),
    ownerCommitment: ownerCommitment(`GFUNDING${index}`), ownerDigest: key(`owner-${index}`),
    positionSeed: key(`private-seed-${index}`), noteChangeCommitment: "0x0", limitPrice: market.oraclePrice,
    margin: 200_000_000n, signedSize: side * 1_000_000_000n }));
  const match = new BatchMatcherService().match({ batchId: "funding-pair", market, intents });
  const settlement = { ...prepareRisc0SettlementDraft({ batchId: "funding-pair", market, intents, match }), proof: proofMeta("batch-match") };
  executor.store.settlements.set(`${market.marketId}:funding-pair`, settlement);
  for (const intent of intents) executor.store.privateMatchIntents.set(intent.intentCommitment, intent);
  for (const fill of match.fills) {
    executor.store.positionCommitments.add(fill.positionCommitment);
    executor.store.positionLifecycle.set(fill.positionCommitment, { batchId: "funding-pair", marketId: market.marketId,
      ownerCommitment: fill.ownerCommitment, positionCommitment: fill.positionCommitment, positionNullifier: fill.positionNullifier,
      sourceIntentCommitment: fill.intentCommitment, settlementDigest: settlement.settlementDigest,
      status: "open", openedAt: 1, updatedAt: 1 });
  }
  const position = [...executor.store.positionLifecycle.values()].find((item) => item.sourceIntentCommitment === intents[0]!.intentCommitment)!;
  const closeCommitment = commitConditionalOrder({ kind: "take-profit", marketId: market.marketId,
    markPrice: market.oraclePrice, positionNullifier: position.positionNullifier, reduceOnly: true,
    salt: "funding", side: "long", size: 1_000_000_000n, triggerPrice: market.oraclePrice - 1n });
  executor.store.addConditionalOrder({ closeCommitment, marketId: market.marketId, positionNullifier: position.positionNullifier });
  const closeInput = hostedPositionCloseWitness({ store: executor.store, position, markPrice: market.oraclePrice,
    currentFundingIndex: market.fundingIndex, assetDigest: key("asset"), closeCommitment }).witness;
  return { closeCommitment, closeInput, executor, ownerCommitment: position.ownerCommitment,
    positionCommitment: position.positionCommitment, positionNullifier: position.positionNullifier };
}

function setupPositionWithConditionalClose(options: { triggered?: boolean } = {}): {
  closeCommitment: Hex;
  closeInput: PositionCloseWitness;
  executor: ExecutorService;
  ownerCommitment: Hex;
  positionCommitment: Hex;
  positionNullifier: Hex;
} {
  const executor = createExecutor();
  const market: MarketConfig = {
    fundingIndex: 15n * PRICE_SCALE,
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
    feeConfigHash: FEE_CONFIG_HASH,
    grossTakerFee: 0n,
    makerRebate: 0n,
    insuranceFee: 0n,
    treasuryFee: 0n,
    makerIntents: [],
    takerIntents: [],
    matchTranscriptDigest: hashFields("match-transcript", ["funding"]),
    matchingPayloadCommitments: [],
    marginChangeCommitments: [],
    marketId: market.marketId,
    newCommitments: [positionCommitment],
    openInterestDelta: 1n,
    orderUpdates: [],
    proof: settlementProof,
    residualSize: 0n,
    residualCommitments: [],
    residualMargins: [],
    residualPayloadCommitments: [],
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

  return {
    closeCommitment,
    closeInput: {
      currentFundingIndex: market.fundingIndex,
      blinding: hashFields("blinding", ["funding"]),
      closeCommitment,
      closeSize: 2n,
      entryPrice: market.oraclePrice,
      fee: 0n,
      fundingIndex: 10n * PRICE_SCALE,
      fundingPayment: 10n,
      margin: 1_000n,
      marginOutputAmount: 990n,
      marginOutputCommitment,
      marginOutputAssetDigest: hashFields("asset", ["usdc"]),
      marginOutputBlinding: hashFields("margin-output-blinding", ["funding"]),
      marginOutputSpendSecretDigest: hashFields("margin-output-spend-secret", ["funding"]),
      marginOutputRhoDigest: hashFields("margin-output-rho", ["funding"]),
      marketDigest: hashFields("market", [market.marketId]),
      marketId: market.marketId,
      markPrice: market.oraclePrice,
      newMargin: 990n,
      newPositionBlinding: hashFields("new-position-blinding", ["funding"]),
      newPositionCommitment,
      newPositionRhoDigest: hashFields("new-position-rho", ["funding"]),
      ownerDigest: hashFields("owner", [owner]),
      pathIndices: Array(20).fill(false),
      pathSiblings: Array(20).fill("0x0" as Hex),
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
    ownerCommitment: owner,
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
    fundingIndex: 17n * PRICE_SCALE,
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
    feeConfigHash: FEE_CONFIG_HASH,
    grossTakerFee: 0n,
    makerRebate: 0n,
    insuranceFee: 0n,
    treasuryFee: 0n,
    makerIntents: [],
    takerIntents: [],
    matchTranscriptDigest: hashFields("match-transcript", ["liquidation"]),
    matchingPayloadCommitments: [],
    marginChangeCommitments: [],
    marketId: market.marketId,
    newCommitments: [positionCommitment],
    openInterestDelta: 3n,
    orderUpdates: [],
    proof: settlementProof,
    residualSize: 0n,
    residualCommitments: [],
    residualMargins: [],
    residualPayloadCommitments: [],
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
      currentFundingIndex: market.fundingIndex,
      blinding: hashFields("blinding", ["liquidation"]),
      entryPrice: 3_400_00000000n,
      fundingIndex: 12n * PRICE_SCALE,
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
