import { describe, expect, test } from "bun:test";
import { PRICE_SCALE, RATE_SCALE } from "@pnlx/market-math";
import type { FundingPremiumSampleRecord, MarketConfig, PrivateMatchIntent } from "@pnlx/protocol-types";
import { clampSigned, currentFundingPremium, fundingPremiumSample, impactExecutionPrice, sampleBucket } from "./funding-premium";

const market: MarketConfig = {
  marketId: "xlm-usd-perp", oraclePrice: 100n * PRICE_SCALE,
  fundingIndex: 0n, initialMarginRate: 100_000n, maintenanceMarginRate: 50_000n, maxLeverage: 10n,
};
const config = { intervalMs: 300_000, sampleIntervalMs: 60_000,
  minimumSamples: 2, premiumMode: "impact-twap" as const, premiumRate: 0n, premiumRateCap: 5_000n };
const sampleConfig = { impactMargin: 500n * 10_000_000n, premiumRateCap: 5_000n, sampleIntervalMs: 60_000 };

function intent(id: string, size: bigint, price: bigint): PrivateMatchIntent {
  return { marketId: market.marketId, intentCommitment: `0x${id}`, signedSize: size,
    limitPrice: price } as PrivateMatchIntent;
}

function observation(at: number, rate: bigint = 0n): FundingPremiumSampleRecord {
  const shift = market.oraclePrice * rate / RATE_SCALE;
  const bid = rate > 0n ? market.oraclePrice + shift : market.oraclePrice + shift - PRICE_SCALE;
  const ask = rate < 0n ? market.oraclePrice + shift : market.oraclePrice + shift + PRICE_SCALE;
  return fundingPremiumSample(market, [
    intent("bid", 100n * 10_000_000n, bid), intent("ask", -100n * 10_000_000n, ask),
  ], at, { ...sampleConfig, oracleObservedAt: at - 1_000, depthObservedAt: at });
}

function completeWindow(end: number, rate = 0n): FundingPremiumSampleRecord[] {
  return Array.from({ length: 5 }, (_, index) => observation(end - config.intervalMs + index * 60_000 + 5_000, rate));
}

describe("funding impact observations", () => {
  test("missing either economically sized side is unavailable, rather than zero", () => {
    const at = 65_000;
    const options = { ...sampleConfig, oracleObservedAt: at, depthObservedAt: at };
    const bid = intent("bid", 100n * 10_000_000n, 101n * PRICE_SCALE);
    const thinAsk = intent("ask", -10n * 10_000_000n, 102n * PRICE_SCALE);
    for (const book of [[], [bid], [bid, thinAsk], [thinAsk]]) {
      expect(fundingPremiumSample(market, book, at, options)).toMatchObject({
        status: "unavailable", premiumRate: null, reason: "insufficient two-sided impact depth",
        impactNotional: 5_000n * 10_000_000n,
      });
    }
  });

  test("genuine two-sided neutral quotes preserve an explicit zero", () => {
    expect(observation(65_000)).toMatchObject({ status: "available", premiumRate: 0n, sampledAt: 60_000, observedAt: 65_000 });
    expect(currentFundingPremium(completeWindow(300_000), config, market.marketId, 300_001)).toMatchObject({
      rate: 0n, status: "ready", coverageMs: 300_000, sampleCount: 5,
    });
  });

  test("signed premiums are capped symmetrically and require both sides", () => {
    expect(observation(65_000, 20_000n).premiumRate).toBe(5_000n);
    expect(observation(65_000, -20_000n).premiumRate).toBe(-5_000n);
    expect(observation(65_000, 1n).premiumRate).toBe(1n);
    expect(observation(65_000, -1n).premiumRate).toBe(-1n);
  });

  test("oracle and book observations must be fresh, explicit, and not future dated", () => {
    const at = 185_000;
    const book = [intent("bid", 100n * 10_000_000n, 99n * PRICE_SCALE), intent("ask", -100n * 10_000_000n, 101n * PRICE_SCALE)];
    for (const times of [
      {}, { oracleObservedAt: at, depthObservedAt: at + 1 },
      { oracleObservedAt: at + 1, depthObservedAt: at },
      { oracleObservedAt: at - 120_001, depthObservedAt: at },
      { oracleObservedAt: at, depthObservedAt: at - 60_001 },
    ]) {
      expect(fundingPremiumSample(market, book, at, { ...sampleConfig, ...times }).premiumRate).toBeNull();
    }
    expect(fundingPremiumSample(market, book, at, {
      ...sampleConfig, oracleObservedAt: at - 120_000, depthObservedAt: at - 60_000,
    }).premiumRate).toBe(0n);
  });

  test("wrong market, duplicate commitments, or malformed quotes cannot inflate depth", () => {
    const bid = intent("same", 100n * 10_000_000n, 99n * PRICE_SCALE);
    const ask = intent("ask", -100n * 10_000_000n, 101n * PRICE_SCALE);
    for (const book of [[bid, bid, ask], [bid, { ...ask, marketId: "other" }], [bid, { ...ask, limitPrice: 0n }]]) {
      expect(fundingPremiumSample(market, book, 65_000, {
        ...sampleConfig, oracleObservedAt: 65_000, depthObservedAt: 65_000,
      })).toMatchObject({ status: "unavailable", premiumRate: null, reason: "invalid funding depth" });
    }
  });

  test("impact price walks price priority using only the requested notional", () => {
    expect(impactExecutionPrice([
      intent("lower", 100n * 10_000_000n, 100n * PRICE_SCALE),
      intent("higher", 10n * 10_000_000n, 102n * PRICE_SCALE),
    ], 5_000n * 10_000_000n, "bid")).toBe(10_040_160_642n);
  });
});

describe("completed funding coverage", () => {
  test("an hour becomes ready only with all 60 completed minute buckets", () => {
    const hourly = { ...config, intervalMs: 3_600_000, minimumSamples: 10 };
    const rows = Array.from({ length: 60 }, (_, index) => observation(index * 60_000 + 5_000, 1_000n));
    expect(currentFundingPremium(rows.slice(0, 59), hourly, market.marketId, 3_600_000)).toMatchObject({
      rate: null, coverageMs: 3_540_000, requiredCoverageMs: 3_600_000,
    });
    expect(currentFundingPremium(rows, hourly, market.marketId, 3_600_000)).toMatchObject({
      rate: 1_000n, status: "ready", sampleCount: 60, coverageMs: 3_600_000,
      windowStart: 0, windowEnd: 3_600_000,
    });
  });

  test("uses only the completed fixed buckets and weights each covered minute once", () => {
    const rows = completeWindow(300_000, 1_000n);
    rows[3] = observation(185_000, -2_000n);
    rows[4] = observation(245_000, -2_000n);
    const result = currentFundingPremium([
      ...rows, rows[0], observation(305_000, 5_000n), observation(10_000, -5_000n),
      { ...observation(65_000, 5_000n), marketId: "other" },
    ], config, market.marketId, 350_000);
    // The later observation in the first bucket replaces its earlier snapshot;
    // a duplicated identical snapshot never increases coverage.
    expect(result).toMatchObject({ windowStart: 0, windowEnd: 300_000, sampleCount: 5,
      coverageMs: 300_000, requiredCoverageMs: 300_000, rate: -1_400n, status: "ready" });
  });

  test("a gap is never stretched or replaced by zero, even after minimum sample count", () => {
    const rows = completeWindow(300_000, 1_000n);
    rows.splice(2, 1);
    expect(currentFundingPremium(rows, config, market.marketId, 300_000)).toMatchObject({
      rate: null, status: "warming", sampleCount: 4, coverageMs: 240_000, requiredCoverageMs: 300_000,
    });
  });

  test("legacy missing-depth zeros and observations without freshness cannot establish coverage", () => {
    const rows = completeWindow(300_000);
    rows[4] = { impactNotional: 1n, indexPrice: market.oraclePrice, marketId: market.marketId,
      premiumRate: 0n, sampledAt: 240_000, source: "impact-orderbook" };
    expect(currentFundingPremium(rows, config, market.marketId, 300_000)).toMatchObject({
      rate: null, status: "unavailable", coverageMs: 240_000,
    });
    rows[4] = { ...observation(245_000), oracleObservedAt: undefined };
    expect(currentFundingPremium(rows, config, market.marketId, 300_000).rate).toBeNull();
  });

  test("unavailable latest depth and conflicting snapshots invalidate their bucket", () => {
    const rows = completeWindow(300_000, 1_000n);
    const missing = { ...rows[4], status: "unavailable" as const, premiumRate: null,
      reason: "insufficient two-sided impact depth", observedAt: 250_000 };
    expect(currentFundingPremium([...rows, missing], config, market.marketId, 300_000)).toMatchObject({
      rate: null, status: "unavailable", coverageMs: 240_000, reason: missing.reason,
    });
    expect(currentFundingPremium([...rows, { ...rows[4], premiumRate: 2_000n }], config, market.marketId, 300_000).rate).toBeNull();
  });

  test("recomputes sample arithmetic and rejects altered rates or misaligned buckets", () => {
    const rows = completeWindow(300_000);
    for (const corrupted of [
      { ...rows[4], premiumRate: 500n }, { ...rows[4], sampledAt: 240_001 },
      { ...rows[4], sampleIntervalMs: 30_000 }, { ...rows[4], impactAskPrice: undefined },
    ]) {
      expect(currentFundingPremium([...rows.slice(0, 4), corrupted], config, market.marketId, 300_000).rate).toBeNull();
    }
  });

  test("rates belong to their own window; later rates cannot fill an earlier missing interval", () => {
    const rows = [...completeWindow(300_000, 1_000n), ...completeWindow(900_000, -2_000n)];
    expect(currentFundingPremium(rows, config, market.marketId, 300_000).rate).toBe(1_000n);
    expect(currentFundingPremium(rows, config, market.marketId, 600_000).rate).toBeNull();
    expect(currentFundingPremium(rows, config, market.marketId, 900_000).rate).toBe(-2_000n);
  });

  test("fixed policy/explicit overrides are separately sourced and symmetrically bounded", () => {
    expect(currentFundingPremium([], { ...config, premiumMode: "fixed", premiumRate: -9_000n }, market.marketId, 300_000))
      .toMatchObject({ rate: -5_000n, source: "fixed", status: "ready", coverageMs: 0 });
    expect(currentFundingPremium([], config, market.marketId, 300_000, 9_000n).rate).toBe(5_000n);
    expect(() => clampSigned(1n, 0n)).toThrow();
    expect(() => sampleBucket(1, 0)).toThrow();
    expect(() => currentFundingPremium([], { ...config, intervalMs: 300_001 }, market.marketId, 300_000)).toThrow("whole sample buckets");
  });
});
