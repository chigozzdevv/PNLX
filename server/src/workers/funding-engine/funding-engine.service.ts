import { fundingIndexDelta, PRICE_SCALE, RATE_SCALE } from "@pnlx/market-math";
import type {
  FundingPremiumSampleRecord,
  FundingUpdateRecord,
  MarketConfig,
  PrivateMatchIntent,
} from "@pnlx/protocol-types";
import type { OnchainRelay, OnchainRelayResult } from "@/workers/onchain/onchain.model";
import type { Prover } from "@/workers/prover/prover.model";
import type { ExecutorService } from "@/workers/executor/executor.service";
import { assertSubmittedRelay } from "@/shared/protocol/onchain-submission";
import { assertPrivateMatchIntent } from "@/workers/batch-matcher/private-intent";
import type {
  FundingCycleMarketResult,
  FundingCycleResult,
  FundingEngineConfig,
  FundingEngineStatus,
  FundingMarketSummary,
  FundingPremiumSampleResult,
  RunFundingCycleInput,
} from "@/workers/funding-engine/funding-engine.model";

const DEFAULT_FUNDING_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_PREMIUM_RATE = 0n;
const DEFAULT_SAMPLE_INTERVAL_MS = 60 * 1000;
const DEFAULT_MINIMUM_SAMPLES = 10;
const DEFAULT_IMPACT_MARGIN = 500n * 10_000_000n;
const DEFAULT_PREMIUM_RATE_CAP = 5_000n;

export class FundingEngineService {
  private fundingTimer: ReturnType<typeof setTimeout> | undefined;
  private settlementRunning = false;
  private sampleTimer: ReturnType<typeof setInterval> | undefined;
  private nextFundingAt: number | null = null;
  private lastCompletedAt: number | null = null;
  private lastError: string | null = null;
  private lastSampleError: string | null = null;
  private readonly failedSamplingMarkets = new Set<string>();
  private settlementBlocked = false;

  constructor(
    private readonly executor: ExecutorService,
    private readonly config: FundingEngineConfig = {
      intervalMs: DEFAULT_FUNDING_INTERVAL_MS,
      premiumRate: DEFAULT_PREMIUM_RATE,
    },
    private readonly prover?: Prover,
    private readonly onchain?: OnchainRelay,
    private readonly now: () => number = Date.now,
  ) {
    assertFundingConfig(config);
  }

  status(): FundingEngineStatus {
    const lastSampledAt = [...this.executor.store.fundingPremiumSamples.values()]
      .reduce<number | null>((latest, sample) => latest === null || sample.sampledAt > latest ? sample.sampledAt : latest, null);
    return {
      samplingRunning: this.sampleTimer !== undefined,
      settlementRunning: this.settlementRunning,
      settlementBlocked: this.settlementBlocked,
      nextFundingAt: this.settlementRunning && !this.settlementBlocked ? this.nextFundingAt : null,
      lastSampledAt,
      lastCompletedAt: this.lastCompletedAt,
      lastError: this.lastError,
      lastSampleError: this.lastSampleError,
    };
  }

  fundingSummary(marketId: string, observedAt = this.now()): FundingMarketSummary {
    if (!this.executor.store.markets.has(marketId)) throw new Error("unknown market");
    const premium = this.premiumForMarket(marketId, observedAt);
    const source = this.config.premiumMode ?? "fixed";
    const sampledAt = source === "fixed" ? null : [...this.executor.store.fundingPremiumSamples.values()]
      .filter((sample) => sample.marketId === marketId && sample.sampledAt <= observedAt)
      .reduce<number | null>((latest, sample) => latest === null || sample.sampledAt > latest ? sample.sampledAt : latest, null);
    const stale = sampledAt !== null && observedAt - sampledAt > maximumSampleAge(this.config);
    const status = stale || (this.failedSamplingMarkets.has(marketId) && sampledAt !== null)
      ? "stale" : premium.reason ? "warming" : "ready";
    return {
      rate: status === "ready" ? premium.rate : null,
      status,
      settlementStatus: this.settlementBlocked ? "blocked" : this.settlementRunning ? "running" : "paused",
      intervalMs: this.config.intervalMs,
      sampleCount: premium.sampleCount ?? 0,
      minimumSamples: source === "fixed" ? 0 : this.config.minimumSamples ?? DEFAULT_MINIMUM_SAMPLES,
      sampledAt,
      nextFundingAt: status === "ready" && this.settlementRunning && !this.settlementBlocked && this.nextFundingAt !== null && this.nextFundingAt > observedAt
        ? this.nextFundingAt : null,
      source,
    };
  }

  sampleOnce(input: { marketId?: string; sampledAt?: number } = {}): FundingPremiumSampleResult[] {
    const sampledAt = sampleBucket(
      input.sampledAt ?? this.now(),
      this.config.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS,
    );
    const records = this.markets(input.marketId).map((market) => {
      try {
        const record = fundingPremiumSample(
          market,
          this.activePrivateIntents(market.marketId),
          sampledAt,
          {
            impactMargin: this.config.impactMargin ?? DEFAULT_IMPACT_MARGIN,
            premiumRateCap: this.config.premiumRateCap ?? DEFAULT_PREMIUM_RATE_CAP,
          },
        );
        this.failedSamplingMarkets.delete(market.marketId);
        return record;
      } catch (error) {
        this.failedSamplingMarkets.add(market.marketId);
        throw error;
      }
    });
    if (records.length > 0) this.executor.store.addFundingPremiumSamples(records);
    return records.map((record) => ({ record }));
  }

  runOnce(input: RunFundingCycleInput = {}): FundingCycleResult {
    const appliedAt = input.appliedAt ?? this.now();
    const markets = this.markets(input.marketId);
    return {
      appliedAt,
      results: markets.map((market) => this.runMarket(market, appliedAt, input)),
    };
  }

  startSampling(): void {
    if (this.sampleTimer) return;
    if ((this.config.premiumMode ?? "fixed") === "impact-twap") {
      this.sampleSafely();
      this.sampleTimer = setInterval(
        () => this.sampleSafely(),
        this.config.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS,
      );
      (this.sampleTimer as { unref?: () => void }).unref?.();
    }
  }

  start(input: Omit<RunFundingCycleInput, "appliedAt" | "elapsedMs"> = {}): void {
    this.startSampling();
    if (this.settlementRunning) return;
    this.settlementBlocked = Boolean(this.config.settlementsOnchainRequired && (!this.onchain?.enabled || !this.prover));
    if (this.settlementBlocked) return;
    this.settlementRunning = true;
    this.scheduleFunding(input);
  }

  private scheduleFunding(input: Omit<RunFundingCycleInput, "appliedAt" | "elapsedMs">): void {
    if (!this.settlementRunning) return;
    this.nextFundingAt = this.now() + this.config.intervalMs;
    this.fundingTimer = setTimeout(() => {
      this.fundingTimer = undefined;
      this.nextFundingAt = null;
      try {
        this.runOnce(input);
        this.lastCompletedAt = this.now();
        this.lastError = null;
        this.settlementBlocked = false;
      } catch (error) {
        this.lastError = "funding settlement cycle failed";
        this.settlementBlocked = true;
        console.error("automatic funding cycle failed", error);
      } finally {
        this.scheduleFunding(input);
      }
    }, this.config.intervalMs);
    (this.fundingTimer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.fundingTimer) clearTimeout(this.fundingTimer);
    this.fundingTimer = undefined;
    this.settlementRunning = false;
    this.nextFundingAt = null;
    this.settlementBlocked = false;
    this.stopSampling();
  }

  stopSampling(): void {
    if (this.sampleTimer) clearInterval(this.sampleTimer);
    this.sampleTimer = undefined;
  }

  private runMarket(
    market: MarketConfig,
    appliedAt: number,
    input: RunFundingCycleInput,
  ): FundingCycleMarketResult {
    const elapsedMs = input.elapsedMs ?? this.elapsedSinceLastFunding(market.marketId, appliedAt);
    if (elapsedMs <= 0) {
      return {
        elapsedMs,
        marketId: market.marketId,
        reason: "no elapsed interval",
        skipped: true,
      };
    }

    const premium = this.premiumForMarket(market.marketId, appliedAt, input.premiumRate);
    if (premium.reason) {
      return {
        elapsedMs,
        marketId: market.marketId,
        reason: premium.reason,
        skipped: true,
      };
    }
    const premiumRate = premium.rate;
    const fundingDelta = fundingIndexDelta({
      elapsedMs,
      intervalMs: this.config.intervalMs,
      markPrice: market.oraclePrice,
      maxFundingDelta: input.maxFundingDelta ?? this.config.maxFundingDelta,
      premiumRate,
    });
    if (fundingDelta === 0n) {
      return {
        elapsedMs,
        marketId: market.marketId,
        reason: "zero funding delta",
        skipped: true,
      };
    }

    const oldFundingIndex = market.fundingIndex;
    const newFundingIndex = oldFundingIndex + fundingDelta;
    if (this.onchain?.enabled && this.prover) {
      const settlement = this.prover.proveFundingSettlement({
        appliedAt,
        elapsedMs,
        intervalMs: this.config.intervalMs,
        markPrice: market.oraclePrice,
        marketId: market.marketId,
        maxFundingDelta: input.maxFundingDelta ?? this.config.maxFundingDelta,
        newFundingIndex,
        oldFundingIndex,
        premiumRate,
      });
      const relay = this.onchain.settleFunding(settlement);
      this.assertSubmittedSettlementRelay(relay);
    } else if (this.config.settlementsOnchainRequired) {
      throw new Error("settlements require on-chain relay");
    }

    const update = this.applyFunding(
      market,
      fundingDelta,
      appliedAt,
      premiumRate,
      premium.sampleCount,
      premium.source,
    );
    return {
      elapsedMs,
      marketId: market.marketId,
      skipped: false,
      update,
    };
  }

  private premiumForMarket(
    marketId: string,
    appliedAt: number,
    override?: bigint,
  ): {
    rate: bigint;
    reason?: string;
    sampleCount?: number;
    source: "fixed" | "impact-twap";
  } {
    if (override === undefined && (this.config.premiumMode ?? "fixed") === "impact-twap" && this.failedSamplingMarkets.has(marketId)) {
      return { rate: 0n, reason: "funding premium sampling unavailable", source: "impact-twap" };
    }
    return currentFundingPremium(
      this.executor.store.fundingPremiumSamples.values(),
      this.config,
      marketId,
      appliedAt,
      override,
    );
  }

  private applyFunding(
    market: MarketConfig,
    fundingDelta: bigint,
    appliedAt: number,
    premiumRate: bigint,
    premiumSampleCount: number | undefined,
    premiumSource: "fixed" | "impact-twap",
  ): FundingUpdateRecord {
    if (fundingDelta === 0n) throw new Error("funding delta cannot be zero");
    const record: FundingUpdateRecord = {
      appliedAt,
      fundingDelta,
      marketId: market.marketId,
      newFundingIndex: market.fundingIndex + fundingDelta,
      oldFundingIndex: market.fundingIndex,
      premiumRate,
      ...(premiumSampleCount === undefined ? {} : { premiumSampleCount }),
      premiumSource,
    };
    this.executor.store.updateMarket({
      ...market,
      fundingIndex: record.newFundingIndex,
    });
    this.executor.store.addFundingUpdate(record);
    return record;
  }

  private activePrivateIntents(marketId: string): PrivateMatchIntent[] {
    const store = this.executor.store;
    const orders = [...store.orderLifecycle.values()].filter((order) => order.marketId === marketId);
    // A partially filled order is an ancestor, not executable depth. Validate its
    // rollover chain so missing residual state cannot masquerade as an empty book.
    for (const source of orders.filter((order) => order.status === "partially-filled")) {
      let current = source;
      const seen = new Set([current.intentCommitment]);
      while (current.status === "partially-filled") {
        const nextId = current.residualCommitment;
        if (!nextId || seen.has(nextId)) throw new Error("funding residual chain is incomplete");
        seen.add(nextId);
        const next = store.orderLifecycle.get(nextId);
        const residual = store.residualOrders.get(nextId);
        if (!next || !residual || next.intentCommitment !== nextId || residual.intentCommitment !== nextId ||
          next.marketId !== marketId || residual.marketId !== marketId ||
          next.ownerCommitment !== current.ownerCommitment || residual.ownerCommitment !== current.ownerCommitment ||
          residual.sourceIntentCommitment !== current.intentCommitment) {
          throw new Error("funding residual chain is incomplete");
        }
        current = next;
      }
      if (current.status !== "open" && current.status !== "filled" && current.status !== "cancelled") {
        throw new Error("funding residual chain is incomplete");
      }
    }
    // This is the same executable status used by the matcher and capacity planner.
    return orders.filter((order) => order.status === "open")
      .map((order) => {
        if (order.residualCommitment) throw new Error("funding open order has an invalid rollover");
        const intent = store.privateMatchIntents.get(order.intentCommitment);
        if (!intent) throw new Error("funding order-book payload is unavailable");
        const record = store.intents.get(order.intentCommitment) ?? store.residualOrders.get(order.intentCommitment);
        if (!record) throw new Error("funding order-book record is unavailable");
        assertPrivateMatchIntent(record, intent);
        return intent;
      });
  }

  sampleSafely(input: { marketId?: string; sampledAt?: number } = {}): void {
    let markets: MarketConfig[];
    try {
      markets = this.markets(input.marketId);
    } catch (error) {
      this.lastSampleError = "funding premium sampling failed";
      console.error("funding premium sampling failed", error);
      return;
    }
    for (const market of markets) {
      try {
        this.sampleOnce({ marketId: market.marketId, sampledAt: input.sampledAt });
      } catch (error) {
        this.lastSampleError = "funding premium sampling failed";
        console.error(`funding premium sampling failed for ${market.marketId}`, error);
      }
    }
    if (this.failedSamplingMarkets.size === 0) this.lastSampleError = null;
  }

  private assertSubmittedSettlementRelay(result: OnchainRelayResult): void {
    if (!this.config.settlementsOnchainRequired) return;
    assertSubmittedRelay(result, "settle");
  }

  private elapsedSinceLastFunding(marketId: string, appliedAt: number): number {
    const last = [...this.executor.store.fundingUpdates.values()]
      .filter((update) => update.marketId === marketId)
      .sort((a, b) => b.appliedAt - a.appliedAt)[0];
    return last ? appliedAt - last.appliedAt : this.config.intervalMs;
  }

  private markets(marketId?: string): MarketConfig[] {
    if (!marketId) return [...this.executor.store.markets.values()];
    const market = this.executor.store.markets.get(marketId);
    if (!market) throw new Error("unknown market");
    return [market];
  }
}

export function fundingPremiumSample(
  market: MarketConfig,
  intents: PrivateMatchIntent[],
  sampledAt: number,
  config: { impactMargin: bigint; premiumRateCap: bigint },
): FundingPremiumSampleRecord {
  if (market.oraclePrice <= 0n) throw new Error("funding index price must be positive");
  if (market.initialMarginRate <= 0n) throw new Error("funding initial margin rate must be positive");
  if (config.impactMargin <= 0n) throw new Error("funding impact margin must be positive");
  if (config.premiumRateCap <= 0n) throw new Error("funding premium cap must be positive");

  const impactNotional = (config.impactMargin * RATE_SCALE) / market.initialMarginRate;
  const bids = intents.filter((intent) => intent.signedSize > 0n);
  const asks = intents.filter((intent) => intent.signedSize < 0n);
  const impactBidPrice = impactExecutionPrice(bids, impactNotional, "bid");
  const impactAskPrice = impactExecutionPrice(asks, impactNotional, "ask");
  const positive = impactBidPrice && impactBidPrice > market.oraclePrice
    ? ((impactBidPrice - market.oraclePrice) * RATE_SCALE) / market.oraclePrice
    : 0n;
  const negative = impactAskPrice && impactAskPrice < market.oraclePrice
    ? ((market.oraclePrice - impactAskPrice) * RATE_SCALE) / market.oraclePrice
    : 0n;

  return {
    ...(impactAskPrice === undefined ? {} : { impactAskPrice }),
    ...(impactBidPrice === undefined ? {} : { impactBidPrice }),
    impactNotional,
    indexPrice: market.oraclePrice,
    marketId: market.marketId,
    premiumRate: clampSigned(positive - negative, config.premiumRateCap),
    sampledAt,
    source: "impact-orderbook",
  };
}

export function currentFundingPremium(
  records: Iterable<FundingPremiumSampleRecord>,
  config: FundingEngineConfig,
  marketId: string,
  appliedAt: number,
  override?: bigint,
): {
  rate: bigint;
  reason?: string;
  sampleCount?: number;
  source: "fixed" | "impact-twap";
} {
  if (override !== undefined || (config.premiumMode ?? "fixed") === "fixed") {
    return {
      rate: clampSigned(
        override ?? config.premiumRate,
        config.premiumRateCap ?? DEFAULT_PREMIUM_RATE_CAP,
      ),
      source: "fixed",
    };
  }

  const cutoff = appliedAt - config.intervalMs;
  const samples = [...records]
    .filter((sample) => sample.marketId === marketId)
    .filter((sample) => sample.sampledAt > cutoff && sample.sampledAt <= appliedAt)
    .sort((left, right) => left.sampledAt - right.sampledAt);
  const minimum = config.minimumSamples ?? DEFAULT_MINIMUM_SAMPLES;
  if (samples.length < minimum) {
    return {
      rate: 0n,
      reason: `insufficient premium samples: ${samples.length}/${minimum}`,
      sampleCount: samples.length,
      source: "impact-twap",
    };
  }
  if (appliedAt - samples.at(-1)!.sampledAt > maximumSampleAge(config)) {
    return {
      rate: 0n,
      reason: "stale premium samples",
      sampleCount: samples.length,
      source: "impact-twap",
    };
  }
  const average = samples.reduce((sum, sample) => sum + sample.premiumRate, 0n) /
    BigInt(samples.length);
  return {
    rate: clampSigned(
      average,
      config.premiumRateCap ?? DEFAULT_PREMIUM_RATE_CAP,
    ),
    sampleCount: samples.length,
    source: "impact-twap",
  };
}

export function impactExecutionPrice(
  intents: PrivateMatchIntent[],
  impactNotional: bigint,
  side: "ask" | "bid",
): bigint | undefined {
  if (impactNotional <= 0n) throw new Error("impact notional must be positive");
  const ordered = [...intents].sort((left, right) => {
    if (left.limitPrice === right.limitPrice) {
      return left.intentCommitment.localeCompare(right.intentCommitment);
    }
    if (side === "bid") return left.limitPrice > right.limitPrice ? -1 : 1;
    return left.limitPrice < right.limitPrice ? -1 : 1;
  });

  let filledNotional = 0n;
  let filledSize = 0n;
  let priceSize = 0n;
  for (const intent of ordered) {
    const availableSize = intent.signedSize < 0n ? -intent.signedSize : intent.signedSize;
    if (availableSize <= 0n || intent.limitPrice <= 0n) continue;
    const remainingNotional = impactNotional - filledNotional;
    const requestedSize = ceilDiv(remainingNotional * PRICE_SCALE, intent.limitPrice);
    const takeSize = requestedSize < availableSize ? requestedSize : availableSize;
    if (takeSize <= 0n) continue;
    filledSize += takeSize;
    priceSize += takeSize * intent.limitPrice;
    filledNotional += (takeSize * intent.limitPrice) / PRICE_SCALE;
    if (filledNotional >= impactNotional) break;
  }
  if (filledNotional < impactNotional || filledSize === 0n) return undefined;
  return priceSize / filledSize;
}

function clampSigned(value: bigint, cap: bigint): bigint {
  if (cap <= 0n) throw new Error("funding premium cap must be positive");
  if (value > cap) return cap;
  if (value < -cap) return -cap;
  return value;
}

function ceilDiv(value: bigint, divisor: bigint): bigint {
  return (value + divisor - 1n) / divisor;
}

function sampleBucket(sampledAt: number, intervalMs: number): number {
  if (!Number.isFinite(sampledAt) || sampledAt < 0) throw new Error("invalid funding sample time");
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error("funding sample interval must be positive");
  }
  return Math.floor(sampledAt / intervalMs) * intervalMs;
}

function maximumSampleAge(config: FundingEngineConfig): number {
  return (config.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS) * 3;
}

function assertFundingConfig(config: FundingEngineConfig): void {
  for (const [name, value] of [
    ["funding interval", config.intervalMs],
    ["funding sample interval", config.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS],
    ["funding minimum samples", config.minimumSamples ?? DEFAULT_MINIMUM_SAMPLES],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  }
  if ((config.impactMargin ?? DEFAULT_IMPACT_MARGIN) <= 0n) throw new Error("funding impact margin must be positive");
  if ((config.premiumRateCap ?? DEFAULT_PREMIUM_RATE_CAP) <= 0n) throw new Error("funding premium cap must be positive");
  if (config.maxFundingDelta !== undefined && config.maxFundingDelta < 0n) throw new Error("funding maximum delta cannot be negative");
}
