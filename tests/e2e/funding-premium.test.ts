import { describe, expect, spyOn, test } from "bun:test";
import { digestToFieldHex, hashFields } from "@pnlx/crypto";
import { PRICE_SCALE } from "@pnlx/market-math";
import type { MarketConfig, PrivateMatchIntent, ProofMeta } from "@pnlx/protocol-types";
import type { Prover, FundingSettlementProofInput } from "@/workers/prover/prover.model";
import type { ExecutorService } from "@/workers/executor/executor.service";
import { BatchMatcherService } from "@/workers/batch-matcher/batch-matcher.service";
import { matchingPayloadCommitment } from "@/workers/batch-matcher/private-intent";
import { prepareRisc0SettlementDraft } from "@/workers/risc0-matcher/risc0-proof";
import { expectedFundingPayment } from "@/shared/protocol/funding";
import {
  currentFundingPremium,
  FundingEngineService,
  fundingPremiumSample,
} from "@/workers/funding-engine/funding-engine.service";
import { HealthController } from "@/features/health/health.controller";
import { loadEnv } from "@/config/env";
import { createFundingEngine } from "@/workers/funding-engine/funding-engine.worker";
import { createExecutor } from "@/workers/executor/executor.worker";

describe("impact TWAP funding", () => {
  test("uses only the remaining executable depth after an actual partial fill", () => {
    const { engine, executor, market, residual } = partiallyFilledFundingBook();
    expect(residual.signedSize).toBe(10n * 10_000_000n);
    const sample = sampleAt(engine, 60_000);
    expect(sample.impactNotional).toBe(5_000n * 10_000_000n);
    expect(sample.impactBidPrice).toBe(10_040_160_642n);
    expect(sample.premiumRate).toBe(4_016n);
    expect(executor.store.orderLifecycle.get(residual.sourceIntentCommitment!)?.status).toBe("partially-filled");
    expect(engine.fundingSummary(market.marketId, 120_000)).toMatchObject({
      rate: null, status: "warming", sampleCount: 1, coverageMs: 60_000,
    });
  });

  test("follows successive residuals without resampling filled ancestors", () => {
    const { engine, executor, market, residual } = partiallyFilledFundingBook();
    const short = fundingBookIntent("second-short", -8n * 10_000_000n, 101n * PRICE_SCALE);
    seedFundingOrder(executor, short);
    const next = settleFundingMatch(executor, market, [residual, short], "funding-depth-second")[0];
    expect(next.signedSize).toBe(2n * 10_000_000n);
    const sample = sampleAt(engine, 60_000);
    expect(sample.impactBidPrice).toBe(10_008_006_405n);
    expect(sample.premiumRate).toBe(800n);
  });

  for (const terminalStatus of ["filled", "cancelled"] as const) {
    test(`excludes ${terminalStatus} residual leaves from funding depth`, () => {
      const { engine, executor, market, residual } = partiallyFilledFundingBook();
      if (terminalStatus === "cancelled") executor.store.cancelOrder(residual.intentCommitment);
      else {
        const short = fundingBookIntent("final-short", -10n * 10_000_000n, 101n * PRICE_SCALE);
        seedFundingOrder(executor, short);
        settleFundingMatch(executor, market, [residual, short], "funding-depth-final");
      }
      expect(executor.store.orderLifecycle.get(residual.intentCommitment)?.status).toBe(terminalStatus);
      const sample = sampleAt(engine, 60_000);
      expect(sample.impactBidPrice).toBe(100n * PRICE_SCALE);
      expect(sample.premiumRate).toBe(0n);
    });
  }

  test("fails closed for missing or cyclic residual chains", () => {
    const { engine, executor, residual } = partiallyFilledFundingBook();
    const source = executor.store.orderLifecycle.get(residual.sourceIntentCommitment!)!;
    executor.store.orderLifecycle.set(source.intentCommitment, { ...source, residualCommitment: undefined });
    expect(() => engine.sampleOnce({ sampledAt: 60_000 })).toThrow("funding residual chain is incomplete");
    executor.store.orderLifecycle.set(source.intentCommitment, source);
    const leaf = executor.store.orderLifecycle.get(residual.intentCommitment)!;
    executor.store.orderLifecycle.delete(residual.intentCommitment);
    expect(() => engine.sampleOnce({ sampledAt: 60_000 })).toThrow("funding residual chain is incomplete");
    executor.store.orderLifecycle.set(residual.intentCommitment, { ...leaf, status: "partially-filled", residualCommitment: source.intentCommitment });
    expect(() => engine.sampleOnce({ sampledAt: 60_000 })).toThrow("funding residual chain is incomplete");
    expect(executor.store.fundingPremiumSamples.size).toBe(0);
  });

  test("reports warming, observed neutral funding, and stale samples without inventing a rate", async () => {
    const executor = createExecutor();
    const market = marketConfig(19_775_000n, "xlm-usd-perp");
    executor.addMarket(market);
    const engine = createFundingEngine(executor, {
      intervalMs: 3_600_000, minimumSamples: 2, premiumMode: "impact-twap", premiumRate: 0n,
      sampleIntervalMs: 60_000,
    });
    expect(engine.fundingSummary(market.marketId, 60_000)).toMatchObject({
      rate: null, status: "warming", settlementStatus: "paused", sampleCount: 0,
      minimumSamples: 2, sampledAt: null, nextFundingAt: null,
    });
    seedNeutralFundingBook(executor, market);
    sampleAt(engine, 60_000);
    expect(engine.fundingSummary(market.marketId, 120_000)).toMatchObject({ rate: null, status: "warming", sampleCount: 1 });
    executor.store.addFundingPremiumSamples(fullWindow(market, 3_600_000, () => 0n));
    expect(engine.fundingSummary(market.marketId, 3_600_001)).toMatchObject({
      rate: 0n, status: "ready", settlementStatus: "paused", sampleCount: 60,
      sampledAt: 3_540_000, nextFundingAt: null, source: "impact-twap",
    });
    expect(engine.fundingSummary(market.marketId, 3_780_001)).toMatchObject({
      rate: null, status: "stale", sampledAt: 3_540_000, nextFundingAt: null,
    });
    expect((await engine.runOnce({ appliedAt: 3_780_001 })).results[0]).toMatchObject({
      skipped: true, reason: "stale premium samples",
    });
  });

  test("samples real empty books while settlement is paused and stops cleanly", () => {
    const executor = createExecutor();
    const market = marketConfig(19_775_000n, "xlm-usd-perp");
    executor.addMarket(market);
    let now = 60_000;
    const engine = new FundingEngineService(executor, {
      intervalMs: 3_600_000, minimumSamples: 2, premiumMode: "impact-twap", premiumRate: 0n,
      sampleIntervalMs: 60_000,
    }, undefined, undefined, () => now);
    try {
      engine.startSampling();
      expect(engine.status()).toMatchObject({ samplingRunning: true, settlementRunning: false, nextFundingAt: null });
      now = 120_000;
      sampleAt(engine, now);
      expect(engine.fundingSummary(market.marketId)).toMatchObject({ rate: null, status: "unavailable", settlementStatus: "paused" });
      expect(executor.store.markets.get(market.marketId)?.fundingIndex).toBe(0n);
      expect(executor.store.fundingUpdates.size).toBe(0);
    } finally { engine.stop(); }
    expect(engine.status()).toMatchObject({ samplingRunning: false, settlementRunning: false, nextFundingAt: null });
  });

  test("continues periodic observations while financial settlement stays paused", async () => {
    const executor = createExecutor();
    const market = marketConfig(19_775_000n, "xlm-usd-perp");
    executor.addMarket(market);
    const engine = createFundingEngine(executor, {
      intervalMs: 60_000, minimumSamples: 2, premiumMode: "impact-twap", premiumRate: 0n,
      sampleIntervalMs: 10,
    });
    try {
      engine.startSampling();
      for (let attempt = 0; attempt < 20 && executor.store.fundingPremiumSamples.size < 2; attempt += 1) await Bun.sleep(5);
      expect(executor.store.fundingPremiumSamples.size).toBeGreaterThanOrEqual(2);
      const latest = [...executor.store.fundingPremiumSamples.values()].sort((a, b) => a.sampledAt - b.sampledAt).at(-1)!;
      expect(engine.fundingSummary(market.marketId, latest.sampledAt + 10)).toMatchObject({
        rate: null, status: "unavailable", settlementStatus: "paused", nextFundingAt: null,
      });
      expect(executor.store.fundingUpdates.size).toBe(0);
    } finally { engine.stop(); }
  });

  test("restores observed rates from persisted samples without claiming a running schedule", async () => {
    const executor = createExecutor();
    const market = marketConfig(19_775_000n, "xlm-usd-perp");
    executor.addMarket(market);
    executor.store.addFundingPremiumSamples(fullWindow(market, 3_600_000, (index) => index < 30 ? -1_000n : -3_000n));
    const config = {
      intervalMs: 3_600_000, minimumSamples: 2, premiumMode: "impact-twap" as const, premiumRate: 0n,
      sampleIntervalMs: 60_000,
    };
    const engine = new FundingEngineService(executor, config, undefined, undefined, () => 3_600_001);
    expect(engine.fundingSummary(market.marketId)).toMatchObject({
      rate: -2_000n, status: "ready", settlementStatus: "paused", sampledAt: 3_540_000, nextFundingAt: null,
    });
    expect((await engine.runOnce()).results[0].update?.fundingDelta).toBe(-39_550n);
    const restarted = new FundingEngineService(executor, config, undefined, undefined, () => 3_600_002);
    expect(restarted.fundingSummary(market.marketId)).toMatchObject({ rate: -2_000n, status: "ready", settlementStatus: "paused", nextFundingAt: null });
    expect(executor.store.markets.get(market.marketId)?.fundingIndex).toBe(-39_550n);
  });

  test("does not treat a missing active order payload as an empty book", () => {
    const executor = createExecutor();
    const market = marketConfig(19_775_000n, "xlm-usd-perp");
    executor.addMarket(market);
    const commitment = hashFields("intent", ["funding-missing-payload"]);
    executor.store.orderLifecycle.set(commitment, {
      marketId: market.marketId, intentCommitment: commitment, batchId: "funding-missing-payload",
      ownerCommitment: hashFields("owner", ["funding-missing-payload"]), status: "open", createdAt: 1, updatedAt: 1,
    });
    const engine = createFundingEngine(executor, {
      intervalMs: 3_600_000, premiumMode: "impact-twap", premiumRate: 0n,
    });
    expect(() => engine.sampleOnce({ sampledAt: 60_000 })).toThrow("funding order-book payload is unavailable");
    expect(executor.store.fundingPremiumSamples.size).toBe(0);
    expect(engine.fundingSummary(market.marketId, 60_000).rate).toBe(null);
  });

  test("continues XLM observations when another market has incomplete order data", async () => {
    const executor = createExecutor();
    const market = marketConfig(19_775_000n, "xlm-usd-perp");
    const broken = marketConfig(100n * PRICE_SCALE, "btc-usd-perp");
    executor.addMarket(market);
    executor.addMarket(broken);
    seedNeutralFundingBook(executor, market);
    executor.store.addFundingPremiumSamples(fullWindow(market, 3_600_000, () => 0n));
    const commitment = hashFields("intent", ["funding-broken-other-market"]);
    executor.store.orderLifecycle.set(commitment, {
      marketId: broken.marketId, intentCommitment: commitment, batchId: "funding-broken-other-market",
      ownerCommitment: hashFields("owner", ["funding-broken-other-market"]), status: "open", createdAt: 1, updatedAt: 1,
    });
    const errorLog = spyOn(console, "error").mockImplementation(() => {});
    const engine = new FundingEngineService(executor, {
      intervalMs: 3_600_000, minimumSamples: 1, premiumMode: "impact-twap", premiumRate: 0n,
    }, undefined, undefined, () => 3_600_000);
    try {
      engine.startSampling();
      await settleTasks();
      await engine.sampleSafely({ sampledAt: 3_600_000, oracleObservedAt: 3_600_000, depthObservedAt: 3_600_000 });
      expect(engine.fundingSummary(market.marketId)).toMatchObject({ status: "ready", rate: 0n, sampledAt: 3_600_000 });
      expect(executor.store.fundingPremiumSamples.get(`${market.marketId}:3600000`)?.status).toBe("available");
      expect(engine.fundingSummary(broken.marketId)).toMatchObject({ status: "warming", rate: null, sampledAt: 3_600_000 });
      expect(engine.status().lastSampleError).toBe("funding premium sampling failed");
      expect(executor.store.fundingPremiumSamples.size).toBe(62);
      executor.store.addFundingPremiumSamples(fullWindow(broken, 3_600_000, () => 0n));
      expect(engine.fundingSummary(broken.marketId)).toMatchObject({ status: "stale", rate: null });
      expect((await engine.runOnce({ marketId: broken.marketId })).results[0]).toMatchObject({ skipped: true, reason: "funding observations unavailable" });
    } finally { engine.stop(); errorLog.mockRestore(); }
  });

  test("publishes a countdown only for a ready, running settlement schedule", async () => {
    const executor = createExecutor();
    const market = marketConfig(19_775_000n, "xlm-usd-perp");
    executor.addMarket(market);
    executor.store.addFundingPremiumSamples(fullWindow(market, 3_600_000, () => 0n));
    let now = 3_600_000;
    const engine = new FundingEngineService(executor, {
      intervalMs: 3_600_000, minimumSamples: 1, premiumMode: "impact-twap", premiumRate: 0n,
      sampleIntervalMs: 60_000,
    }, undefined, undefined, () => now);
    expect(engine.fundingSummary(market.marketId).nextFundingAt).toBe(null);
    try {
      engine.startSampling();
      engine.start();
      await settleTasks();
      expect(engine.fundingSummary(market.marketId)).toMatchObject({
        rate: 0n, status: "ready", settlementStatus: "running", nextFundingAt: 7_200_000,
      });
      engine.start();
      expect(engine.status().nextFundingAt).toBe(7_200_000);
      now = 7_200_001;
      expect(engine.fundingSummary(market.marketId).nextFundingAt).toBe(null);
      engine.stop();
      expect(engine.fundingSummary(market.marketId)).toMatchObject({ settlementStatus: "paused", nextFundingAt: null });
      engine.start();
      await settleTasks();
      expect(engine.status().nextFundingAt).toBe(10_860_000);
    } finally { engine.stop(); }
  });

  test("blocks settlement startup when required relay dependencies are missing", async () => {
    const executor = createExecutor();
    const market = marketConfig(19_775_000n, "xlm-usd-perp");
    executor.addMarket(market);
    const engine = createFundingEngine(executor, {
      intervalMs: 3_600_000, minimumSamples: 1, premiumMode: "impact-twap", premiumRate: 0n,
      settlementsOnchainRequired: true,
    });
    try {
      engine.start();
      await settleTasks();
      expect(engine.status()).toMatchObject({ samplingRunning: true, settlementBlocked: true, nextFundingAt: null });
      expect(engine.fundingSummary(market.marketId).settlementStatus).toBe("blocked");
      expect(executor.store.fundingUpdates.size).toBe(0);
    } finally { engine.stop(); }
  });

  test("schedules the next funding attempt after a slow cycle finishes", async () => {
    const executor = createExecutor();
    const market = marketConfig(19_775_000n, "xlm-usd-perp");
    executor.addMarket(market);
    let now = 100;
    let cycles = 0;
    let finish!: () => void;
    const proving = new Promise<void>((resolve) => { finish = resolve; });
    const timers = fundingTimers();
    const engine = new FundingEngineService(executor, {
      intervalMs: 20, sampleIntervalMs: 10, premiumMode: "fixed", premiumRate: 1_000n,
    }, fundingProver(async () => { cycles++; await proving; }), undefined, () => now);
    try {
      engine.start();
      await settleTasks();
      expect(engine.fundingSummary(market.marketId).nextFundingAt).toBe(120);
      now = 120;
      timers.fire();
      await settleTasks();
      expect(cycles).toBe(1);
      expect(timers.size()).toBe(0);
      expect(engine.status().nextFundingAt).toBeNull();
      now = 175;
      finish();
      await settleTasks();
      expect(engine.status()).toMatchObject({ lastCompletedAt: 175, nextFundingAt: 176 });
      expect(engine.fundingSummary(market.marketId).nextFundingAt).toBe(176);
      expect(timers.size()).toBe(1);
    } finally { engine.stop(); timers.restore(); }
  });

  test("reports failed settlement cycles as blocked until a successful retry", async () => {
    const executor = createExecutor();
    const market = marketConfig(19_775_000n, "xlm-usd-perp");
    executor.addMarket(market);
    let now = 100;
    let cycles = 0;
    const timers = fundingTimers();
    const errorLog = spyOn(console, "error").mockImplementation(() => {});
    const engine = new FundingEngineService(executor, {
      intervalMs: 20, sampleIntervalMs: 10, premiumMode: "fixed", premiumRate: 1_000n,
    }, fundingProver(async () => {
      cycles += 1;
      if (cycles === 1) throw new Error("funding settlement relay unavailable");
    }), undefined, () => now);
    try {
      engine.start();
      await settleTasks();
      now = 120;
      timers.fire();
      await settleTasks();
      expect(cycles).toBe(1);
      expect(engine.fundingSummary(market.marketId)).toMatchObject({ settlementStatus: "blocked", nextFundingAt: null });
      expect(engine.status().lastError).toBe("funding settlement cycle failed");
      now = 150;
      timers.fire();
      await settleTasks();
      expect(cycles).toBe(2);
      expect(engine.status()).toMatchObject({ settlementRunning: true, settlementBlocked: false, lastError: null, lastCompletedAt: 150 });
      expect(engine.fundingSummary(market.marketId)).toMatchObject({ settlementStatus: "running", nextFundingAt: 151 });
    } finally { engine.stop(); errorLog.mockRestore(); timers.restore(); }
  });

  test("health distinguishes configured settlement pause from live premium sampling", async () => {
    const executor = createExecutor();
    const market = marketConfig(19_775_000n, "xlm-usd-perp");
    executor.addMarket(market);
    const engine = createFundingEngine(executor, {
      intervalMs: 3_600_000, premiumMode: "impact-twap", premiumRate: 0n,
    });
    const env = { ...loadEnv(), fundingEngineEnabled: false, fundingPremiumMode: "impact-twap" as const };
    try {
      engine.startSampling();
      const body = await new HealthController(env, undefined, undefined, undefined, engine).get().json();
      expect(body.funding).toMatchObject({ enabled: false, effective: false, samplingRunning: true, settlementStatus: "paused", nextFundingAt: null });
    } finally { engine.stop(); }
  });

  test("rejects invalid funding scheduler configuration", () => {
    const executor = createExecutor();
    const config = { intervalMs: 3_600_000, premiumMode: "impact-twap" as const, premiumRate: 0n };
    expect(() => createFundingEngine(executor, { ...config, intervalMs: 0 })).toThrow("funding interval must be a positive integer");
    expect(() => createFundingEngine(executor, { ...config, sampleIntervalMs: Number.NaN })).toThrow("funding sample interval must be a positive integer");
    expect(() => createFundingEngine(executor, { ...config, minimumSamples: 1.5 })).toThrow("funding minimum samples must be a positive integer");
  });

  test("exposes the current market premium without requiring a nonzero funding update", () => {
    const market = marketConfig(19_775_000n, "xlm-usd-perp");
    const result = currentFundingPremium(
      fullWindow(market, 3_600_000, () => 0n),
      {
        intervalMs: 3_600_000,
        minimumSamples: 2,
        premiumMode: "impact-twap",
        premiumRate: 0n,
        premiumRateCap: 5_000n,
      },
      market.marketId,
      3_600_000,
    );

    expect(result).toMatchObject({
      rate: 0n,
      status: "ready",
      sampleCount: 60,
      coverageMs: 3_600_000,
      source: "impact-twap",
    });
  });

  test("derives and caps the premium from economically sized order-book depth", () => {
    const market = marketConfig(100n * PRICE_SCALE);
    const sample = fundingPremiumSample(
      market,
      [
        intent("bid", 50n * 10_000_000n, 102n * PRICE_SCALE),
        intent("ask", -50n * 10_000_000n, 100n * PRICE_SCALE),
      ],
      60_000,
      {
        impactMargin: 500n * 10_000_000n,
        premiumRateCap: 5_000n,
        oracleObservedAt: 60_000,
        depthObservedAt: 60_000,
      },
    );

    expect(sample.impactNotional).toBe(5_000n * 10_000_000n);
    expect(sample.impactBidPrice).toBe(102n * PRICE_SCALE);
    expect(sample.impactAskPrice).toBe(100n * PRICE_SCALE);
    expect(sample.premiumRate).toBe(5_000n);
  });

  test("uses an hourly average and preserves precision for a low-priced market", async () => {
    const executor = createExecutor();
    const market = marketConfig(19_775_000n, "xlm-usd-perp");
    executor.addMarket(market);
    executor.store.addFundingPremiumSamples(fullWindow(market, 3_600_000, (index) => index < 30 ? 1_000n : 3_000n));
    const engine = createFundingEngine(executor, {
      impactMargin: 500n * 10_000_000n,
      intervalMs: 3_600_000,
      minimumSamples: 2,
      premiumMode: "impact-twap",
      premiumRate: 0n,
      premiumRateCap: 5_000n,
      sampleIntervalMs: 60_000,
    });

    const result = await engine.runOnce({
      appliedAt: 3_600_000,
      marketId: market.marketId,
    });

    expect(result.results[0].skipped).toBe(false);
    expect(result.results[0].update?.premiumRate).toBe(2_000n);
    expect(result.results[0].update?.premiumSampleCount).toBe(60);
    expect(result.results[0].update?.premiumSource).toBe("impact-twap");
    expect(engine.fundingSummary(market.marketId, 3_600_000)).toMatchObject({ sampleCount: 60, coverageMs: 3_600_000 });
    expect(result.results[0].update?.fundingDelta).toBe(39_550n);
  });

  test("skips dynamic funding until enough samples exist", async () => {
    const executor = createExecutor();
    const market = marketConfig(100n * PRICE_SCALE);
    executor.addMarket(market);
    executor.store.addFundingPremiumSamples([premiumSample(market, 1_000, 1_000n)]);
    const engine = createFundingEngine(executor, {
      intervalMs: 3_600_000,
      minimumSamples: 2,
      premiumMode: "impact-twap",
      premiumRate: 0n,
    });

    const result = await engine.runOnce({ appliedAt: 3_600_000, marketId: market.marketId });

    expect(result.results[0].skipped).toBe(true);
    expect(result.results[0].reason).toBe("stale premium samples");
    executor.store.addFundingPremiumSamples([premiumSample(market, 7_140_000, 1_000n)]);
    const recent = await engine.runOnce({ appliedAt: 7_200_000, marketId: market.marketId });
    expect(recent.results[0]).toMatchObject({ skipped: true, reason: "insufficient premium coverage: 60000/3600000ms (1/2 samples)" });
  });

  test("keeps one observation per configured time bucket", () => {
    const executor = createExecutor();
    const market = marketConfig(100n * PRICE_SCALE);
    executor.addMarket(market);
    const engine = createFundingEngine(executor, {
      intervalMs: 3_600_000,
      minimumSamples: 2,
      premiumMode: "impact-twap",
      premiumRate: 0n,
      sampleIntervalMs: 60_000,
    });

    engine.sampleOnce({ marketId: market.marketId, sampledAt: 60_001 });
    engine.sampleOnce({ marketId: market.marketId, sampledAt: 119_999 });

    expect(executor.store.fundingPremiumSamples.size).toBe(1);
    expect([...executor.store.fundingPremiumSamples.values()][0].sampledAt).toBe(60_000);
  });

  test("scales position funding payments consistently with PnL units", () => {
    expect(expectedFundingPayment("long", 10_000_000n, 50n * PRICE_SCALE, 0n)).toBe(
      500_000_000n,
    );
    expect(expectedFundingPayment("short", 10_000_000n, 50n * PRICE_SCALE, 0n)).toBe(
      -500_000_000n,
    );
  });
});

function marketConfig(oraclePrice: bigint, marketId = "btc-usd-perp"): MarketConfig {
  return {
    fundingIndex: 0n,
    initialMarginRate: 100_000n,
    maintenanceMarginRate: 50_000n,
    marketId,
    maxLeverage: 10n,
    oraclePrice,
  };
}

function intent(label: string, signedSize: bigint, limitPrice: bigint): PrivateMatchIntent {
  return {
    batchId: "funding-sample",
    intentCommitment: hashFields("intent", [label]),
    limitPrice,
    margin: 1_000n,
    marketId: "btc-usd-perp",
    noteChangeCommitment: "0x0",
    noteNullifier: hashFields("nullifier", [label]),
    ownerCommitment: hashFields("owner", [label]),
    ownerDigest: hashFields("fixture-owner-digest", [label]),
    positionSeed: hashFields("fixture-position-seed", [label]),
    signedSize,
  };
}

function premiumSample(market: MarketConfig, sampledAt: number, premiumRate: bigint) {
  const bucket = Math.floor(sampledAt / 60_000) * 60_000;
  const shift = market.oraclePrice * premiumRate / 1_000_000n;
  return {
    status: "available" as const,
    observedAt: bucket + 1_000,
    oracleObservedAt: bucket,
    depthObservedAt: bucket + 1_000,
    sampleIntervalMs: 60_000,
    impactBidPrice: premiumRate > 0n ? market.oraclePrice + shift : market.oraclePrice - 1n,
    impactAskPrice: premiumRate < 0n ? market.oraclePrice + shift : market.oraclePrice + 1n,
    impactNotional: 5_000n * 10_000_000n,
    indexPrice: market.oraclePrice,
    marketId: market.marketId,
    premiumRate,
    sampledAt: bucket,
    source: "impact-orderbook" as const,
  };
}

function fullWindow(market: MarketConfig, end: number, rate: (index: number) => bigint) {
  return Array.from({ length: 60 }, (_, index) => premiumSample(market, end - 3_600_000 + index * 60_000, rate(index)));
}

function sampleAt(engine: FundingEngineService, sampledAt: number) {
  return engine.sampleOnce({ sampledAt, oracleObservedAt: sampledAt, depthObservedAt: sampledAt })[0].record;
}

function seedNeutralFundingBook(executor: ExecutorService, market: MarketConfig): void {
  seedFundingOrder(executor, { ...fundingBookIntent(`${market.marketId}-neutral-bid`, 100_000n * 10_000_000n, market.oraclePrice - 1n), marketId: market.marketId });
  seedFundingOrder(executor, { ...fundingBookIntent(`${market.marketId}-neutral-ask`, -100_000n * 10_000_000n, market.oraclePrice + 1n), marketId: market.marketId });
}

async function settleTasks(): Promise<void> {
  for (let turn = 0; turn < 40; turn++) await Promise.resolve();
}

function fundingProver(beforeProof: () => Promise<void>): Prover {
  return { async proveFundingSettlementAsync(input: FundingSettlementProofInput) {
    await beforeProof();
    return { ...input, fundingDelta: input.newFundingIndex - input.oldFundingIndex, proof: fundingFixtureProof("funding") };
  } } as Prover;
}

function fundingTimers() {
  const tasks = new Map<ReturnType<typeof setTimeout>, () => void>();
  const schedule = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
    const handle = { unref() {} } as ReturnType<typeof setTimeout>;
    tasks.set(handle, callback);
    return handle;
  }) as typeof setTimeout);
  const cancel = spyOn(globalThis, "clearTimeout").mockImplementation(((handle: ReturnType<typeof setTimeout>) => {
    tasks.delete(handle);
  }) as typeof clearTimeout);
  return {
    fire() {
      const next = tasks.entries().next().value;
      if (!next) throw new Error("no scheduled funding timer");
      tasks.delete(next[0]); next[1]();
    },
    size: () => tasks.size,
    restore() { schedule.mockRestore(); cancel.mockRestore(); },
  };
}

function fundingBookIntent(label: string, signedSize: bigint, limitPrice: bigint): PrivateMatchIntent {
  return {
    ...intent(label, signedSize, limitPrice),
    intentCommitment: digestToFieldHex(`funding-depth-intent:${label}`),
    noteNullifier: digestToFieldHex(`funding-depth-nullifier:${label}`),
    ownerDigest: digestToFieldHex(`funding-depth-owner:${label}`),
    positionSeed: digestToFieldHex(`funding-depth-seed:${label}`),
    margin: 2_500n * 10_000_000n,
  };
}

function fundingFixtureProof(label: string): ProofMeta {
  return {
    circuitId: "batch-match", circuitHash: hashFields("circuit", [label]), circuitKey: hashFields("key", [label]),
    proofDigest: hashFields("proof", [label]), publicInputHash: hashFields("input", [label]), verifierHash: hashFields("verifier", [label]),
  };
}

function seedFundingOrder(executor: ExecutorService, payload: PrivateMatchIntent): void {
  const proof = fundingFixtureProof(payload.intentCommitment);
  executor.store.recordProof(proof);
  executor.store.addIntent({
    batchId: payload.batchId, batchDigest: hashFields("batch", [payload.batchId]),
    marketId: payload.marketId, marketDigest: hashFields("market", [payload.marketId]),
    marginRoot: executor.store.marginMembershipRoot(), assetDigest: hashFields("asset", ["USDC"]), currentBatch: 0n,
    ownerCommitmentField: digestToFieldHex(`funding-owner:${payload.ownerCommitment}`), ownerCommitment: payload.ownerCommitment,
    intentCommitment: payload.intentCommitment, matchingPayloadCommitment: matchingPayloadCommitment(payload),
    noteChangeCommitment: payload.noteChangeCommitment, noteNullifier: payload.noteNullifier, proof,
  }, payload);
}

function settleFundingMatch(executor: ExecutorService, market: MarketConfig, intents: PrivateMatchIntent[], batchId: string): PrivateMatchIntent[] {
  const match = new BatchMatcherService().match({ market, intents, batchId });
  const proof = fundingFixtureProof(batchId);
  const settlement = { ...prepareRisc0SettlementDraft({ market, intents, match, batchId }), proof };
  executor.store.recordProof(proof);
  executor.store.addSettlement(settlement, match.fills.map((fill) => ({
    batchId, marketId: market.marketId, ownerCommitment: fill.ownerCommitment,
    positionCommitment: fill.positionCommitment, positionNullifier: fill.positionNullifier,
    settlementDigest: settlement.settlementDigest, sourceIntentCommitment: fill.intentCommitment,
    openedAt: 1, updatedAt: 1, status: "open", size: fill.size, side: fill.side,
  })), match.residuals.map((residual) => ({
    batchId, marketId: market.marketId, ownerCommitment: residual.ownerCommitment,
    intentCommitment: residual.intentCommitment, noteNullifier: residual.noteNullifier,
    matchingPayloadCommitment: matchingPayloadCommitment(residual),
    sourceIntentCommitment: residual.sourceIntentCommitment!, createdAt: 1, updatedAt: 1,
  })), [], match.residuals);
  return match.residuals;
}

function partiallyFilledFundingBook() {
  const executor = createExecutor();
  const market = marketConfig(100n * PRICE_SCALE);
  executor.addMarket(market);
  const bid = fundingBookIntent("depth-bid", 100n * 10_000_000n, 102n * PRICE_SCALE);
  const ask = fundingBookIntent("depth-ask", -90n * 10_000_000n, 101n * PRICE_SCALE);
  seedFundingOrder(executor, bid);
  seedFundingOrder(executor, ask);
  const residual = settleFundingMatch(executor, market, [bid, ask], "funding-depth-first")[0];
  seedFundingOrder(executor, fundingBookIntent("fallback-bid", 100n * 10_000_000n, 100n * PRICE_SCALE));
  seedFundingOrder(executor, fundingBookIntent("standing-ask", -100n * 10_000_000n, 103n * PRICE_SCALE));
  const engine = createFundingEngine(executor, {
    intervalMs: 3_600_000, minimumSamples: 1, premiumMode: "impact-twap", premiumRate: 0n,
  });
  return { engine, executor, market, residual };
}
