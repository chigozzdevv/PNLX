import { describe, expect, test } from "bun:test";
import { hashFields } from "@pnlx/crypto";
import { PRICE_SCALE } from "@pnlx/market-math";
import type { MarketConfig, PrivateMatchIntent } from "@pnlx/protocol-types";
import { expectedFundingPayment } from "@/shared/protocol/funding";
import {
  fundingPremiumSample,
} from "@/workers/funding-engine/funding-engine.service";
import { createFundingEngine } from "@/workers/funding-engine/funding-engine.worker";
import { createExecutor } from "@/workers/executor/executor.worker";

describe("impact TWAP funding", () => {
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
      },
    );

    expect(sample.impactNotional).toBe(5_000n * 10_000_000n);
    expect(sample.impactBidPrice).toBe(102n * PRICE_SCALE);
    expect(sample.impactAskPrice).toBe(100n * PRICE_SCALE);
    expect(sample.premiumRate).toBe(5_000n);
  });

  test("uses an hourly average and preserves precision for a low-priced market", () => {
    const executor = createExecutor();
    const market = marketConfig(19_775_000n, "xlm-usd-perp");
    executor.addMarket(market);
    executor.store.addFundingPremiumSamples([
      premiumSample(market, 1_000, 1_000n),
      premiumSample(market, 2_000, 3_000n),
    ]);
    const engine = createFundingEngine(executor, {
      impactMargin: 500n * 10_000_000n,
      intervalMs: 3_600_000,
      minimumSamples: 2,
      premiumMode: "impact-twap",
      premiumRate: 0n,
      premiumRateCap: 5_000n,
      sampleIntervalMs: 60_000,
    });

    const result = engine.runOnce({
      appliedAt: 3_000,
      elapsedMs: 3_600_000,
      marketId: market.marketId,
    });

    expect(result.results[0].skipped).toBe(false);
    expect(result.results[0].update?.premiumRate).toBe(2_000n);
    expect(result.results[0].update?.premiumSampleCount).toBe(2);
    expect(result.results[0].update?.fundingDelta).toBe(39_550n);
  });

  test("skips dynamic funding until enough samples exist", () => {
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

    const result = engine.runOnce({ appliedAt: 2_000, marketId: market.marketId });

    expect(result.results[0].skipped).toBe(true);
    expect(result.results[0].reason).toBe("insufficient premium samples: 1/2");
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
    signedSize,
  };
}

function premiumSample(market: MarketConfig, sampledAt: number, premiumRate: bigint) {
  return {
    impactNotional: 5_000n * 10_000_000n,
    indexPrice: market.oraclePrice,
    marketId: market.marketId,
    premiumRate,
    sampledAt,
    source: "impact-orderbook" as const,
  };
}
