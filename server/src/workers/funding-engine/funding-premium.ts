import { PRICE_SCALE, RATE_SCALE } from "@pnlx/market-math";
import type { FundingPremiumSampleRecord, MarketConfig, PrivateMatchIntent } from "@pnlx/protocol-types";

const DEFAULT_SAMPLE_INTERVAL_MS = 60_000;
const DEFAULT_PREMIUM_RATE_CAP = 5_000n;

export interface FundingSampleConfig {
  impactMargin: bigint;
  premiumRateCap: bigint;
  sampleIntervalMs?: number;
  oracleObservedAt?: number;
  depthObservedAt?: number;
  maxOracleAgeMs?: number;
  maxDepthAgeMs?: number;
}

export interface FundingPremiumConfig {
  intervalMs: number;
  premiumMode?: "fixed" | "impact-twap";
  premiumRate: bigint;
  premiumRateCap?: bigint;
  minimumSamples?: number;
  sampleIntervalMs?: number;
  maxOracleAgeMs?: number;
  maxDepthAgeMs?: number;
}

export interface FundingPremium {
  rate: bigint | null;
  reason?: string;
  status: "ready" | "warming" | "unavailable" | "stale";
  sampleCount: number;
  source: "fixed" | "impact-twap";
  coverageMs: number;
  requiredCoverageMs: number;
  windowStart: number;
  windowEnd: number;
}

/** Observations represent one fixed bucket, never an intervening missing bucket. */
export function fundingPremiumSample(
  market: MarketConfig,
  intents: PrivateMatchIntent[],
  observedAt: number,
  config: FundingSampleConfig,
): FundingPremiumSampleRecord {
  const interval = config.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
  const sampledAt = sampleBucket(observedAt, interval);
  if (config.impactMargin <= 0n) throw new Error("funding impact margin must be positive");
  clampSigned(0n, config.premiumRateCap);
  const impactNotional = market.initialMarginRate > 0n
    ? (config.impactMargin * RATE_SCALE) / market.initialMarginRate : 0n;
  const record: FundingPremiumSampleRecord = {
    status: "unavailable", observedAt, sampledAt, sampleIntervalMs: interval,
    ...(config.oracleObservedAt === undefined ? {} : { oracleObservedAt: config.oracleObservedAt }),
    ...(config.depthObservedAt === undefined ? {} : { depthObservedAt: config.depthObservedAt }),
    impactNotional, indexPrice: market.oraclePrice, marketId: market.marketId,
    premiumRate: null, source: "impact-orderbook",
  };
  if (market.oraclePrice <= 0n || impactNotional <= 0n) {
    return { ...record, reason: "invalid funding market prices" };
  }
  const freshness = observationFreshness(record, config);
  if (freshness) return { ...record, reason: freshness };
  if (new Set(intents.map((intent) => intent.intentCommitment.toLowerCase())).size !== intents.length ||
      intents.some((intent) => intent.marketId !== market.marketId ||
      typeof intent.signedSize !== "bigint" || intent.signedSize === 0n ||
      typeof intent.limitPrice !== "bigint" || intent.limitPrice <= 0n)) {
    return { ...record, reason: "invalid funding depth" };
  }
  const impactBidPrice = impactExecutionPrice(intents.filter((intent) => intent.signedSize > 0n), impactNotional, "bid");
  const impactAskPrice = impactExecutionPrice(intents.filter((intent) => intent.signedSize < 0n), impactNotional, "ask");
  const prices = {
    ...(impactBidPrice === undefined ? {} : { impactBidPrice }),
    ...(impactAskPrice === undefined ? {} : { impactAskPrice }),
  };
  if (impactBidPrice === undefined || impactAskPrice === undefined) {
    return { ...record, ...prices, reason: "insufficient two-sided impact depth" };
  }
  return {
    ...record, ...prices, status: "available",
    premiumRate: premiumFromPrices(impactBidPrice, impactAskPrice, market.oraclePrice, config.premiumRateCap),
  };
}

/**
 * Require 100% of the completed interval, plus the configured minimum samples.
 * A minute observation has exactly one minute of weight; holes are never filled
 * with zero or a previous rate. The open bucket has no weight. Callers settle
 * each returned window once using its own duration, never a later rate over a gap.
 */
export function currentFundingPremium(
  records: Iterable<FundingPremiumSampleRecord>,
  config: FundingPremiumConfig,
  marketId: string,
  appliedAt: number,
  override?: bigint,
): FundingPremium {
  const interval = config.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
  positiveInteger(config.intervalMs, "funding interval");
  const windowEnd = sampleBucket(appliedAt, interval);
  const windowStart = windowEnd - config.intervalMs;
  const cap = config.premiumRateCap ?? DEFAULT_PREMIUM_RATE_CAP;
  clampSigned(0n, cap);
  const base = {
    sampleCount: 0, coverageMs: 0, requiredCoverageMs: config.intervalMs, windowStart, windowEnd,
    source: "impact-twap" as const,
  };
  if (override !== undefined || (config.premiumMode ?? "fixed") === "fixed") {
    return { ...base, source: "fixed", status: "ready", rate: clampSigned(override ?? config.premiumRate, cap) };
  }
  if (config.intervalMs % interval !== 0) throw new Error("funding interval must contain whole sample buckets");
  const minimum = config.minimumSamples ?? 10;
  positiveInteger(minimum, "funding minimum samples");
  const buckets = new Map<number, FundingPremiumSampleRecord>();
  const conflicts = new Set<number>();
  for (const sample of records) {
    if (sample.marketId !== marketId || !Number.isSafeInteger(sample.sampledAt) ||
        sample.sampledAt < windowStart || sample.sampledAt >= windowEnd) continue;
    const previous = buckets.get(sample.sampledAt);
    const time = sample.observedAt ?? sample.sampledAt;
    const previousTime = previous?.observedAt ?? previous?.sampledAt ?? -1;
    if (!previous || time > previousTime) {
      buckets.set(sample.sampledAt, sample);
      conflicts.delete(sample.sampledAt);
    } else if (time === previousTime && !sameObservation(sample, previous)) {
      conflicts.add(sample.sampledAt);
    }
  }
  const samples = [...buckets.values()].sort((a, b) => a.sampledAt - b.sampledAt);
  const valid = samples.filter((sample) => !conflicts.has(sample.sampledAt) && validSample(sample, config, cap));
  const result = { ...base, sampleCount: valid.length, coverageMs: valid.length * interval };
  const latest = samples.at(-1);
  if (latest && appliedAt - (latest.observedAt ?? latest.sampledAt) > maximumSampleAge(config)) {
    return { ...result, status: "stale", rate: null, reason: "stale premium samples" };
  }
  if (latest && !valid.includes(latest)) {
    return { ...result, status: "unavailable", rate: null,
      reason: latest.reason ?? "unverified funding observation" };
  }
  if (valid.length < minimum || result.coverageMs !== config.intervalMs) {
    return { ...result, status: "warming", rate: null,
      reason: `insufficient premium coverage: ${result.coverageMs}/${config.intervalMs}ms (${valid.length}/${minimum} samples)` };
  }
  const weighted = valid.reduce((sum, sample) => sum + sample.premiumRate! * BigInt(interval), 0n);
  return { ...result, status: "ready", rate: clampSigned(weighted / BigInt(result.coverageMs), cap) };
}

function validSample(sample: FundingPremiumSampleRecord, config: FundingPremiumConfig, cap: bigint): boolean {
  const interval = config.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
  return sample.status === "available" && sample.source === "impact-orderbook" &&
    sample.sampleIntervalMs === interval && sample.sampledAt % interval === 0 &&
    Number.isSafeInteger(sample.observedAt) && sample.observedAt! >= sample.sampledAt &&
    sample.observedAt! < sample.sampledAt + interval && !observationFreshness(sample, config) &&
    typeof sample.impactNotional === "bigint" && sample.impactNotional > 0n &&
    typeof sample.indexPrice === "bigint" && sample.indexPrice > 0n &&
    typeof sample.impactBidPrice === "bigint" && sample.impactBidPrice > 0n &&
    typeof sample.impactAskPrice === "bigint" && sample.impactAskPrice > 0n &&
    typeof sample.premiumRate === "bigint" &&
    sample.premiumRate === premiumFromPrices(sample.impactBidPrice, sample.impactAskPrice, sample.indexPrice, cap);
}

function observationFreshness(sample: FundingPremiumSampleRecord, config: {
  maxOracleAgeMs?: number; maxDepthAgeMs?: number; sampleIntervalMs?: number;
}): string | undefined {
  for (const [name, at, maximum] of [
    ["oracle", sample.oracleObservedAt, config.maxOracleAgeMs ?? 120_000],
    ["depth", sample.depthObservedAt, config.maxDepthAgeMs ?? config.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS],
  ] as const) {
    positiveInteger(maximum, `funding ${name} maximum age`);
    if (!Number.isSafeInteger(at) || at! < 0 || sample.observedAt === undefined ||
        at! > sample.observedAt || sample.observedAt - at! > maximum) return `funding ${name} observation unavailable or stale`;
  }
}

function premiumFromPrices(bid: bigint, ask: bigint, index: bigint, cap: bigint): bigint {
  const positive = bid > index ? ((bid - index) * RATE_SCALE) / index : 0n;
  const negative = ask < index ? ((index - ask) * RATE_SCALE) / index : 0n;
  return clampSigned(positive - negative, cap);
}

function sameObservation(a: FundingPremiumSampleRecord, b: FundingPremiumSampleRecord): boolean {
  return a.status === b.status && a.reason === b.reason && a.premiumRate === b.premiumRate &&
    a.impactBidPrice === b.impactBidPrice && a.impactAskPrice === b.impactAskPrice &&
    a.indexPrice === b.indexPrice && a.impactNotional === b.impactNotional &&
    a.sampleIntervalMs === b.sampleIntervalMs && a.oracleObservedAt === b.oracleObservedAt &&
    a.depthObservedAt === b.depthObservedAt && a.source === b.source;
}

export function impactExecutionPrice(intents: PrivateMatchIntent[], impactNotional: bigint, side: "ask" | "bid"): bigint | undefined {
  if (impactNotional <= 0n) throw new Error("impact notional must be positive");
  const ordered = [...intents].sort((a, b) => a.limitPrice === b.limitPrice
    ? a.intentCommitment.localeCompare(b.intentCommitment)
    : (side === "bid" ? a.limitPrice > b.limitPrice : a.limitPrice < b.limitPrice) ? -1 : 1);
  let filledNotional = 0n;
  let filledSize = 0n;
  let priceSize = 0n;
  for (const intent of ordered) {
    const size = intent.signedSize < 0n ? -intent.signedSize : intent.signedSize;
    if (size <= 0n || intent.limitPrice <= 0n) continue;
    const remaining = impactNotional - filledNotional;
    const requested = (remaining * PRICE_SCALE + intent.limitPrice - 1n) / intent.limitPrice;
    const take = requested < size ? requested : size;
    filledSize += take;
    priceSize += take * intent.limitPrice;
    filledNotional += (take * intent.limitPrice) / PRICE_SCALE;
    if (filledNotional >= impactNotional) break;
  }
  return filledNotional < impactNotional || filledSize === 0n ? undefined : priceSize / filledSize;
}

export function sampleBucket(at: number, intervalMs: number): number {
  if (!Number.isSafeInteger(at) || at < 0) throw new Error("invalid funding sample time");
  positiveInteger(intervalMs, "funding sample interval");
  return Math.floor(at / intervalMs) * intervalMs;
}

export function maximumSampleAge(config: Pick<FundingPremiumConfig, "sampleIntervalMs">): number {
  return (config.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS) * 3;
}

export function clampSigned(value: bigint, cap: bigint): bigint {
  if (typeof value !== "bigint") throw new Error("funding premium must be an integer");
  if (typeof cap !== "bigint" || cap <= 0n) throw new Error("funding premium cap must be positive");
  return value > cap ? cap : value < -cap ? -cap : value;
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
}
