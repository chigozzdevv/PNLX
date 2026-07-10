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
import type {
  FundingCycleMarketResult,
  FundingCycleResult,
  FundingEngineConfig,
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
  private fundingTimer: ReturnType<typeof setInterval> | undefined;
  private sampleTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly executor: ExecutorService,
    private readonly config: FundingEngineConfig = {
      intervalMs: DEFAULT_FUNDING_INTERVAL_MS,
      premiumRate: DEFAULT_PREMIUM_RATE,
    },
    private readonly prover?: Prover,
    private readonly onchain?: OnchainRelay,
  ) {}

  sampleOnce(input: { marketId?: string; sampledAt?: number } = {}): FundingPremiumSampleResult[] {
    const sampledAt = sampleBucket(
      input.sampledAt ?? Date.now(),
      this.config.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS,
    );
    const records = this.markets(input.marketId).map((market) =>
      fundingPremiumSample(
        market,
        this.activePrivateIntents(market.marketId),
        sampledAt,
        {
          impactMargin: this.config.impactMargin ?? DEFAULT_IMPACT_MARGIN,
          premiumRateCap: this.config.premiumRateCap ?? DEFAULT_PREMIUM_RATE_CAP,
        },
      )
    );
    if (records.length > 0) this.executor.store.addFundingPremiumSamples(records);
    return records.map((record) => ({ record }));
  }

  runOnce(input: RunFundingCycleInput = {}): FundingCycleResult {
    const appliedAt = input.appliedAt ?? Date.now();
    const markets = this.markets(input.marketId);
    return {
      appliedAt,
      results: markets.map((market) => this.runMarket(market, appliedAt, input)),
    };
  }

  start(input: Omit<RunFundingCycleInput, "appliedAt" | "elapsedMs"> = {}): void {
    if (this.fundingTimer || this.sampleTimer) return;
    if ((this.config.premiumMode ?? "fixed") === "impact-twap") {
      this.sampleSafely();
      this.sampleTimer = setInterval(
        () => this.sampleSafely(),
        this.config.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS,
      );
      (this.sampleTimer as { unref?: () => void }).unref?.();
    }
    this.fundingTimer = setInterval(() => {
      try {
        this.runOnce(input);
      } catch (error) {
        console.error("automatic funding cycle failed", error);
      }
    }, this.config.intervalMs);
    (this.fundingTimer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.fundingTimer) clearInterval(this.fundingTimer);
    if (this.sampleTimer) clearInterval(this.sampleTimer);
    this.fundingTimer = undefined;
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
    if (override !== undefined || (this.config.premiumMode ?? "fixed") === "fixed") {
      return {
        rate: clampSigned(
          override ?? this.config.premiumRate,
          this.config.premiumRateCap ?? DEFAULT_PREMIUM_RATE_CAP,
        ),
        source: "fixed",
      };
    }

    const cutoff = appliedAt - this.config.intervalMs;
    const samples = [...this.executor.store.fundingPremiumSamples.values()]
      .filter((sample) => sample.marketId === marketId)
      .filter((sample) => sample.sampledAt > cutoff && sample.sampledAt <= appliedAt)
      .sort((left, right) => left.sampledAt - right.sampledAt);
    const minimum = this.config.minimumSamples ?? DEFAULT_MINIMUM_SAMPLES;
    if (samples.length < minimum) {
      return {
        rate: 0n,
        reason: `insufficient premium samples: ${samples.length}/${minimum}`,
        sampleCount: samples.length,
        source: "impact-twap",
      };
    }
    const average = samples.reduce((sum, sample) => sum + sample.premiumRate, 0n) /
      BigInt(samples.length);
    return {
      rate: clampSigned(
        average,
        this.config.premiumRateCap ?? DEFAULT_PREMIUM_RATE_CAP,
      ),
      sampleCount: samples.length,
      source: "impact-twap",
    };
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
    return [...this.executor.store.privateMatchIntents.values()].filter((intent) => {
      if (intent.marketId !== marketId) return false;
      const status = this.executor.store.orderLifecycle.get(intent.intentCommitment)?.status;
      return status === "open" || status === "partially-filled";
    });
  }

  private sampleSafely(): void {
    try {
      this.sampleOnce();
    } catch (error) {
      console.error("funding premium sampling failed", error);
    }
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
