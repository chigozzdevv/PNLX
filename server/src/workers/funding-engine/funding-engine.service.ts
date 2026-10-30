import { fundingIndexDelta } from "@pnlx/market-math";
import { fieldHex, hashFields } from "@pnlx/crypto";
import type { FundingCycleRecord, FundingPremiumSampleRecord, FundingUpdateRecord, Hex, MarketConfig, PrivateMatchIntent } from "@pnlx/protocol-types";
import type { OnchainRelay } from "@/workers/onchain/onchain.model";
import type { Prover } from "@/workers/prover/prover.model";
import type { ExecutorService } from "@/workers/executor/executor.service";
import { assertPrivateMatchIntent } from "@/workers/batch-matcher/private-intent";
import { assertPositionMutationReady, withPositionMutation } from "@/shared/protocol/position-mutation";
import { batchSelectionInputs } from "@/workers/batch-executor/batch-capacity";
import { currentFundingPremium, fundingPremiumSample, sampleBucket, type FundingPremium } from "./funding-premium";
import type { FundingCycleMarketResult, FundingCycleResult, FundingEngineConfig, FundingEngineStatus, FundingMarketSummary, FundingPremiumSampleResult, RunFundingCycleInput } from "./funding-engine.model";
export { currentFundingPremium, fundingPremiumSample, impactExecutionPrice } from "./funding-premium";

const DEFAULT_FUNDING_INTERVAL_MS = 3_600_000;
const DEFAULT_PREMIUM_RATE = 0n;
const DEFAULT_SAMPLE_INTERVAL_MS = 60_000;
const DEFAULT_MINIMUM_SAMPLES = 10;
const DEFAULT_IMPACT_MARGIN = 500n * 10_000_000n;
const DEFAULT_PREMIUM_RATE_CAP = 5_000n;
const MAX_INDEX = (1n << 127n) - 1n;
type SampleInput = { marketId?: string; sampledAt?: number; oracleObservedAt?: number; depthObservedAt?: number; oraclePrice?: bigint };
const SHARED = new WeakMap<object, { jobs: Map<string, Promise<FundingCycleMarketResult>>; samples: Map<string, Promise<void>> }>();

export class FundingEngineService {
  private fundingTimer: ReturnType<typeof setTimeout> | undefined;
  private sampleTimer: ReturnType<typeof setInterval> | undefined;
  private settlementRunning = false;
  private settlementBlocked = false;
  private nextFundingAt: number | null = null;
  private lastCompletedAt: number | null = null;
  private lastError: string | null = null;
  private lastSampleError: string | null = null;
  private generation = 0;
  private readonly failedSamplingMarkets = new Set<string>();
  private readonly ownedCycles = new Set<Hex>();
  private readonly shared: NonNullable<ReturnType<typeof SHARED.get>>;

  constructor(private readonly executor: ExecutorService,
    private readonly config: FundingEngineConfig = { intervalMs: DEFAULT_FUNDING_INTERVAL_MS, premiumRate: DEFAULT_PREMIUM_RATE },
    private readonly prover?: Prover, private readonly onchain?: OnchainRelay,
    private readonly now: () => number = Date.now) {
    assertFundingConfig(config);
    this.shared = SHARED.get(executor.store) ?? { jobs: new Map(), samples: new Map() };
    SHARED.set(executor.store, this.shared);
  }

  private get requiresChain(): boolean { return Boolean(this.config.settlementsOnchainRequired || this.onchain?.enabled); }
  status(): FundingEngineStatus {
    const lastSampledAt = [...this.executor.store.fundingPremiumSamples.values()]
      .reduce<number | null>((latest, sample) => latest === null || sample.sampledAt > latest ? sample.sampledAt : latest, null);
    return { samplingRunning: this.sampleTimer !== undefined, settlementRunning: this.settlementRunning,
      settlementBlocked: this.settlementBlocked, nextFundingAt: this.settlementRunning && !this.settlementBlocked ? this.nextFundingAt : null,
      lastSampledAt, lastCompletedAt: this.lastCompletedAt, lastError: this.lastError, lastSampleError: this.lastSampleError };
  }

  fundingSummary(marketId: string, observedAt = this.now()): FundingMarketSummary {
    if (!this.executor.store.markets.has(marketId)) throw new Error("unknown market");
    const premium = this.premiumForMarket(marketId, observedAt);
    const source = this.config.premiumMode ?? "fixed";
    const sampledAt = source === "fixed" ? null : [...this.executor.store.fundingPremiumSamples.values()]
      .filter((sample) => sample.marketId === marketId && sample.sampledAt <= observedAt)
      .reduce<number | null>((latest, sample) => latest === null || sample.sampledAt > latest ? sample.sampledAt : latest, null);
    return { rate: premium.status === "ready" ? premium.rate : null, status: premium.status,
      reason: premium.reason, coverageMs: premium.coverageMs, requiredCoverageMs: premium.requiredCoverageMs,
      windowStart: premium.windowStart, windowEnd: premium.windowEnd,
      settlementStatus: this.settlementBlocked ? "blocked" : this.settlementRunning ? "running" : "paused",
      intervalMs: this.config.intervalMs, sampleCount: premium.sampleCount,
      minimumSamples: source === "fixed" ? 0 : this.config.minimumSamples ?? DEFAULT_MINIMUM_SAMPLES, sampledAt,
      nextFundingAt: premium.status === "ready" && this.settlementRunning && !this.settlementBlocked &&
        this.nextFundingAt !== null && this.nextFundingAt > observedAt ? this.nextFundingAt : null, source };
  }

  /** Pure sampling entry point: callers must supply actual observation times. */
  sampleOnce(input: SampleInput = {}): FundingPremiumSampleResult[] {
    const observedAt = input.sampledAt ?? this.now();
    const records = this.markets(input.marketId).map((market) => {
      try {
        const record = fundingPremiumSample({ ...market, oraclePrice: input.oraclePrice ?? market.oraclePrice },
          this.activePrivateIntents(market.marketId), observedAt, { impactMargin: this.config.impactMargin ?? DEFAULT_IMPACT_MARGIN,
            premiumRateCap: this.config.premiumRateCap ?? DEFAULT_PREMIUM_RATE_CAP,
            sampleIntervalMs: this.config.sampleIntervalMs, oracleObservedAt: input.oracleObservedAt,
            depthObservedAt: input.depthObservedAt, maxOracleAgeMs: this.config.maxOracleAgeMs, maxDepthAgeMs: this.config.maxDepthAgeMs });
        this.failedSamplingMarkets.delete(market.marketId);
        return record;
      } catch (error) { this.failedSamplingMarkets.add(market.marketId); throw error; }
    });
    if (records.length) this.executor.store.addFundingPremiumSamples(records);
    return records.map((record) => ({ record }));
  }

  async sampleSafely(input: SampleInput = {}): Promise<void> {
    let markets: MarketConfig[];
    try { markets = this.markets(input.marketId); }
    catch { this.lastSampleError = "funding premium sampling failed"; return; }
    await Promise.all(markets.map((market) => {
      const pending = this.shared.samples.get(market.marketId);
      if (pending) return pending;
      const job = (async () => {
        try {
          let oraclePrice = input.oraclePrice;
          let oracleObservedAt = input.oracleObservedAt;
          if (this.onchain?.enabled) {
            if (!this.onchain.marketPriceSnapshotAsync) throw new Error("funding oracle observations unavailable");
            const oracle = await this.onchain.marketPriceSnapshotAsync(market.marketId);
            oraclePrice = oracle.price; oracleObservedAt = oracle.timestamp * 1_000;
          }
          const observedAt = this.onchain?.enabled ? this.now() : input.sampledAt ?? this.now();
          this.sampleOnce({ marketId: market.marketId, sampledAt: observedAt, oraclePrice, oracleObservedAt,
            depthObservedAt: input.depthObservedAt ?? this.now() });
        } catch {
          this.failedSamplingMarkets.add(market.marketId);
          this.lastSampleError = "funding premium sampling failed";
          const observedAt = this.onchain?.enabled ? this.now() : input.sampledAt ?? this.now();
          const record = fundingPremiumSample(market, [], observedAt, { impactMargin: this.config.impactMargin ?? DEFAULT_IMPACT_MARGIN,
            premiumRateCap: this.config.premiumRateCap ?? DEFAULT_PREMIUM_RATE_CAP, sampleIntervalMs: this.config.sampleIntervalMs });
          try { this.executor.store.addFundingPremiumSamples([{ ...record, reason: "funding observations unavailable" }]); }
          catch { /* Persistence health owns the write failure. Sampling never fails a trade batch. */ }
        }
      })().finally(() => { if (this.shared.samples.get(market.marketId) === job) this.shared.samples.delete(market.marketId); });
      this.shared.samples.set(market.marketId, job);
      return job;
    }));
    if (!this.failedSamplingMarkets.size) this.lastSampleError = null;
  }

  startSampling(): void {
    if (this.sampleTimer || (this.config.premiumMode ?? "fixed") !== "impact-twap") return;
    void this.sampleSafely();
    this.sampleTimer = setInterval(() => void this.sampleSafely(), this.config.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS);
    this.sampleTimer.unref?.();
  }
  stopSampling(): void { if (this.sampleTimer) clearInterval(this.sampleTimer); this.sampleTimer = undefined; }

  async runOnce(input: RunFundingCycleInput = {}): Promise<FundingCycleResult> {
    const appliedAt = input.appliedAt ?? this.now();
    if (!Number.isSafeInteger(appliedAt) || appliedAt < 0) throw new Error("invalid funding cycle time");
    if (this.requiresChain && (input.elapsedMs !== undefined || input.premiumRate !== undefined || input.maxFundingDelta !== undefined)) {
      throw new Error("live funding arithmetic overrides are disabled");
    }
    const generation = this.generation;
    const jobs = this.markets(input.marketId).map((market) => {
      const pending = this.shared.jobs.get(market.marketId);
      if (pending) return pending;
      const work = this.runMarket(market.marketId, appliedAt, input, generation).finally(() => {
        if (this.shared.jobs.get(market.marketId) === work) this.shared.jobs.delete(market.marketId);
      });
      this.shared.jobs.set(market.marketId, work); return work;
    });
    const settled = await Promise.allSettled(jobs);
    const failed = settled.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") {
      if (generation === this.generation) { this.settlementBlocked = true; this.lastError = "funding settlement cycle failed"; }
      throw failed.reason;
    }
    if (generation === this.generation) { this.settlementBlocked = false; this.lastError = null; this.lastCompletedAt = this.now(); }
    return { appliedAt, results: settled.map((result) => (result as PromiseFulfilledResult<FundingCycleMarketResult>).value) };
  }

  start(input: Omit<RunFundingCycleInput, "appliedAt" | "elapsedMs"> = {}): void {
    this.startSampling();
    if (this.settlementRunning) return;
    this.settlementRunning = true;
    const generation = this.generation;
    void this.initializeActivation(generation).then(() => {
      if (generation === this.generation && this.settlementRunning) this.scheduleFunding(input);
    }).catch(() => {
      if (generation !== this.generation || !this.settlementRunning) return;
      this.settlementBlocked = true; this.settlementRunning = false; this.nextFundingAt = null;
      this.lastError = "funding activation protections are unavailable";
    });
  }

  private async initializeActivation(generation: number): Promise<void> {
    if (this.requiresChain) await this.assertActivationReady();
    const bucket = this.config.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
    const anchor = Math.ceil(this.now() / bucket) * bucket;
    for (const market of this.markets()) {
      const pending = this.pendingCycle(market.marketId);
      if (pending?.submissionAttempted) continue;
      if (pending && this.shared.jobs.has(market.marketId)) continue;
      if (pending) {
        this.executor.store.upsertFundingCycle({ ...pending, status: "retired",
          reason: "unsubmitted preparation ended before activation", updatedAt: this.now() });
        await this.flush();
      }
      this.assertGeneration(generation);
      const cursor = this.executor.store.fundingCursors.get(market.marketId)?.windowEnd ?? 0;
      if (anchor > cursor) await withPositionMutation(this.executor.store, async () => {
        this.assertGeneration(generation);
        this.skipWindow(market, cursor, anchor, "funding activated after this observation window"); await this.flush();
      });
    }
  }

  private scheduleFunding(input: Omit<RunFundingCycleInput, "appliedAt" | "elapsedMs">, generation = this.generation): void {
    if (!this.settlementRunning || generation !== this.generation || this.fundingTimer) return;
    const pending = [...this.executor.store.fundingCycles.values()].some((cycle) => cycle.status === "prepared" || cycle.status === "attempted");
    const targets = this.markets().map((market) =>
      (this.executor.store.fundingCursors.get(market.marketId)?.windowEnd ?? this.now()) + this.config.intervalMs);
    const next = pending || this.settlementBlocked ? this.now() + Math.min(30_000, this.config.intervalMs)
      : Math.max(this.now() + 1, targets.length ? Math.min(...targets) : this.now() + this.config.intervalMs);
    this.nextFundingAt = next;
    const timer = setTimeout(() => {
      if (generation !== this.generation || !this.settlementRunning || this.fundingTimer !== timer) return;
      this.fundingTimer = undefined; this.nextFundingAt = null;
      void this.runOnce(input).catch(() => undefined).finally(() => this.scheduleFunding(input, generation));
    }, next - this.now());
    this.fundingTimer = timer;
    timer.unref?.();
  }
  stop(): void {
    this.generation++; if (this.fundingTimer) clearTimeout(this.fundingTimer);
    this.fundingTimer = undefined; this.settlementRunning = false; this.nextFundingAt = null; this.settlementBlocked = false;
    this.stopSampling();
    for (const cycle of this.executor.store.fundingCycles.values()) {
      if (cycle.status === "prepared" && !cycle.submissionAttempted && this.ownedCycles.has(cycle.cycleId)) {
        try { this.executor.store.upsertFundingCycle({ ...cycle, status: "retired",
          reason: "funding stopped before submission", updatedAt: this.now() }); }
        catch { this.lastError = "funding preparation retirement could not be persisted"; }
      }
    }
  }

  private async runMarket(marketId: string, appliedAt: number, input: RunFundingCycleInput, generation: number): Promise<FundingCycleMarketResult> {
    const recovery = this.pendingCycle(marketId);
    if (recovery) return this.settleCycle(recovery, generation);
    const interval = this.config.intervalMs;
    const end = sampleBucket(appliedAt, this.config.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS);
    const start = end - interval;
    const cursor = this.executor.store.fundingCursors.get(marketId)?.windowEnd;
    if (start < 0 || (cursor !== undefined && end <= cursor)) return { marketId, elapsedMs: 0, skipped: true, reason: "no completed funding window" };
    if (cursor !== undefined && start < cursor) return { marketId, elapsedMs: 0, skipped: true, reason: "funding observation window is not complete" };
    let market = this.executor.store.markets.get(marketId)!;
    if (cursor !== undefined && cursor < start) await withPositionMutation(this.executor.store, async () => {
      this.assertGeneration(generation); this.skipWindow(market, cursor, start, "unsettled funding windows were not extrapolated"); await this.flush();
    });
    const premium = this.premiumForMarket(marketId, end, input.premiumRate);
    if (premium.rate === null || premium.status !== "ready") {
      await withPositionMutation(this.executor.store, async () => {
        this.assertGeneration(generation); this.skipWindow(market, start, end, premium.reason ?? "funding observations unavailable"); await this.flush();
      });
      return { marketId, elapsedMs: interval, skipped: true, reason: premium.reason };
    }
    if (this.requiresChain) {
      await this.assertActivationReady();
      const snapshot = await this.onchain!.marketPriceSnapshotAsync!(marketId);
      this.assertFreshOracle(snapshot.timestamp, this.now());
      const index = await this.onchain!.marketFundingIndexAsync!(marketId);
      if (index !== market.fundingIndex) throw new Error("funding index requires chain reconciliation");
      market = { ...market, oraclePrice: snapshot.price, fundingIndex: index };
    }
    this.assertGeneration(generation);
    const delta = fundingIndexDelta({ elapsedMs: interval, intervalMs: interval, markPrice: market.oraclePrice,
      premiumRate: premium.rate, maxFundingDelta: input.maxFundingDelta ?? this.config.maxFundingDelta });
    if (delta === 0n) {
      await withPositionMutation(this.executor.store, async () => {
        this.assertGeneration(generation); this.skipWindow(market, start, end, "zero funding delta", premium.rate!); await this.flush();
      });
      return { marketId, elapsedMs: interval, skipped: true, reason: "zero funding delta" };
    }
    const newFundingIndex = market.fundingIndex + delta;
    if (newFundingIndex < -MAX_INDEX || newFundingIndex > MAX_INDEX) throw new Error("funding index exceeds signed protocol range");
    const cycle: FundingCycleRecord = { cycleId: fieldHex(BigInt(hashFields("funding-cycle", [marketId, start, end, market.fundingIndex,
      newFundingIndex, market.oraclePrice, premium.rate]))), marketId, windowStart: start, windowEnd: end,
      intervalMs: interval, oldFundingIndex: market.fundingIndex, newFundingIndex, markPrice: market.oraclePrice,
      premiumRate: premium.rate, maxFundingDelta: input.maxFundingDelta ?? this.config.maxFundingDelta,
      premiumSampleCount: premium.sampleCount, premiumSource: premium.source,
      status: "prepared", updatedAt: this.now() };
    this.ownedCycles.add(cycle.cycleId);
    this.executor.store.upsertFundingCycle(cycle); await this.flush();
    return this.settleCycle(cycle, generation);
  }

  private async settleCycle(captured: FundingCycleRecord, generation: number): Promise<FundingCycleMarketResult> {
    let cycle = this.executor.store.fundingCycles.get(captured.cycleId)!;
    if (cycle.status === "retired" || cycle.status === "skipped") throw new Error("funding preparation is no longer active");
    if (!cycle.submissionAttempted) this.assertGeneration(generation);
    this.ownedCycles.add(cycle.cycleId);
    if (!cycle.settlement) {
      const input = { cycleId: cycle.cycleId, appliedAt: cycle.windowEnd, elapsedMs: cycle.windowEnd - cycle.windowStart, intervalMs: cycle.intervalMs,
        marketId: cycle.marketId, oldFundingIndex: cycle.oldFundingIndex, newFundingIndex: cycle.newFundingIndex,
        markPrice: cycle.markPrice, premiumRate: cycle.premiumRate!, maxFundingDelta: cycle.maxFundingDelta };
      const settlement = this.prover?.proveFundingSettlementAsync ? await this.prover.proveFundingSettlementAsync(input)
        : this.requiresChain ? (() => { throw new Error("asynchronous funding prover is unavailable"); })()
        : { ...input, fundingDelta: cycle.newFundingIndex - cycle.oldFundingIndex, proof: {} } as never;
      this.assertGeneration(generation);
      cycle = { ...cycle, settlement: { ...settlement, premiumSampleCount: cycle.premiumSampleCount,
        premiumSource: cycle.premiumSource }, updatedAt: this.now() };
      this.executor.store.upsertFundingCycle(cycle); await this.flush();
    }
    return withPositionMutation(this.executor.store, async () => {
      cycle = this.executor.store.fundingCycles.get(cycle.cycleId)!;
      if (cycle.status === "settled") return { marketId: cycle.marketId, elapsedMs: cycle.intervalMs, skipped: false,
        update: this.executor.store.finalizeFundingCycle(cycle.cycleId) };
      if (this.requiresChain) {
        if (!this.onchain?.enabled || !this.onchain.isFundingSettledAsync) throw new Error("exact funding confirmation is unavailable");
        const confirmed = await this.onchain.isFundingSettledAsync(cycle.marketId, cycle.oldFundingIndex, cycle.newFundingIndex, cycle.cycleId);
        if (confirmed === true && await this.onchain.marketFundingIndexAsync!(cycle.marketId) !== cycle.newFundingIndex) {
          throw new Error("funding confirmation does not match the current chain index");
        }
        if (confirmed !== true) {
          if (cycle.submissionAttempted) {
            const failed = cycle.settlementTxHash && this.onchain.fundingTransactionStatusAsync &&
              await this.onchain.fundingTransactionStatusAsync(cycle.settlementTxHash) === "FAILED";
            if (failed && await this.onchain.marketFundingIndexAsync!(cycle.marketId) === cycle.oldFundingIndex) {
              this.executor.store.confirmFundingCycleFailure(cycle.cycleId, { marketId: cycle.marketId,
                oldFundingIndex: cycle.oldFundingIndex, newFundingIndex: cycle.newFundingIndex,
                settlementTxHash: cycle.settlementTxHash!, observedAt: this.now() });
              await this.flush();
              return { marketId: cycle.marketId, elapsedMs: cycle.intervalMs, skipped: true, reason: "funding transaction failed" };
            }
            throw new Error("funding submission outcome is unknown; exact reconciliation required");
          }
          this.assertGeneration(generation);
          await this.assertActivationReady();
          assertPositionMutationReady(this.executor.store, "funding", cycle.cycleId);
          const [index, oracle] = await Promise.all([this.onchain.marketFundingIndexAsync!(cycle.marketId),
            this.onchain.marketPriceSnapshotAsync!(cycle.marketId)]);
          this.assertFreshOracle(oracle.timestamp, this.now());
          if (index !== cycle.oldFundingIndex) throw new Error("funding index changed before submission");
          if (oracle.price !== cycle.markPrice) {
            this.executor.store.upsertFundingCycle({ ...cycle, status: "retired", reason: "funding oracle changed before submission", updatedAt: this.now() });
            await this.flush(); throw new Error("funding oracle changed before submission; proof was retired without sending");
          }
          await this.onchain.settleFundingAsync!(cycle.settlement!, async (prepared) => {
            this.assertGeneration(generation);
            const current = this.executor.store.fundingCycles.get(cycle.cycleId)!;
            cycle = { ...current, status: "attempted", submissionAttempted: true, settlementTxHash: prepared.txHash,
              preparedXdr: prepared.xdr, updatedAt: this.now() };
            this.executor.store.upsertFundingCycle(cycle); await this.flush();
          });
          if (await this.onchain.isFundingSettledAsync(cycle.marketId, cycle.oldFundingIndex, cycle.newFundingIndex, cycle.cycleId) !== true) {
            throw new Error("funding settlement is not confirmed on chain");
          }
          if (await this.onchain.marketFundingIndexAsync!(cycle.marketId) !== cycle.newFundingIndex) {
            throw new Error("confirmed funding index changed before local checkpoint");
          }
        }
      } else { this.assertGeneration(generation); assertPositionMutationReady(this.executor.store, "funding", cycle.cycleId); }
      const update = this.executor.store.finalizeFundingCycle(cycle.cycleId); await this.flush();
      this.ownedCycles.delete(cycle.cycleId);
      return { marketId: cycle.marketId, elapsedMs: cycle.intervalMs, skipped: false, update };
    });
  }

  private skipWindow(market: MarketConfig, start: number, end: number, reason: string, premiumRate: bigint | null = null): void {
    if (end <= start) return;
    this.executor.store.skipFundingCycle({ cycleId: fieldHex(BigInt(hashFields("funding-window-skip", [market.marketId, start, end]))),
      marketId: market.marketId, windowStart: start, windowEnd: end, intervalMs: this.config.intervalMs,
      oldFundingIndex: market.fundingIndex, newFundingIndex: market.fundingIndex, markPrice: market.oraclePrice,
      premiumRate, status: "skipped", reason, updatedAt: this.now() });
  }
  private pendingCycle(marketId: string): FundingCycleRecord | undefined {
    const pending = [...this.executor.store.fundingCycles.values()].filter((cycle) => cycle.marketId === marketId &&
      (cycle.status === "prepared" || cycle.status === "attempted")).sort((a, b) => a.windowEnd - b.windowEnd);
    if (pending.length > 1) throw new Error("overlapping funding journals require reconciliation");
    return pending[0];
  }
  private premiumForMarket(marketId: string, end: number, override?: bigint): FundingPremium {
    const premium = currentFundingPremium(this.executor.store.fundingPremiumSamples.values(), this.config, marketId, end, override);
    return this.failedSamplingMarkets.has(marketId) && premium.status === "ready"
      ? { ...premium, rate: null, status: "stale", reason: "funding observations unavailable" } : premium;
  }
  private async assertActivationReady(): Promise<void> {
    if (!this.onchain?.enabled || !this.prover?.proveFundingSettlementAsync || !this.onchain.settleFundingAsync ||
      !this.onchain.marketFundingIndexAsync || !this.onchain.marketPriceSnapshotAsync || !this.onchain.isFundingSettledAsync ||
      !this.onchain.fundingActivationReadyAsync || await this.onchain.fundingActivationReadyAsync() !== true) {
      throw new Error("funding activation protections are unavailable");
    }
  }
  private assertFreshOracle(timestamp: number, at: number): void {
    const observedAt = timestamp * 1_000;
    if (!Number.isSafeInteger(observedAt) || observedAt > at || at - observedAt > (this.config.maxOracleAgeMs ?? 120_000)) {
      throw new Error("funding oracle is stale");
    }
  }
  private assertGeneration(generation: number): void { if (generation !== this.generation) throw new Error("funding worker stopped"); }
  private async flush(): Promise<void> {
    const store = this.executor.store as typeof this.executor.store & { flush?: () => Promise<void> };
    if (store.flush) await store.flush();
  }
  private markets(marketId?: string): MarketConfig[] {
    if (marketId) { const market = this.executor.store.markets.get(marketId); if (!market) throw new Error("unknown market"); return [market]; }
    return [...this.executor.store.markets.values()];
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
    const heldIds = new Set<string>(), heldNullifiers = new Set<string>();
    for (const run of store.batchExecutionRuns.values()) {
      if (run.marketId !== marketId || (run.status !== "running" && run.status !== "failed") ||
          (!run.submissionAttempted && run.phase !== "proving" && !run.settlementDigest)) continue;
      if (store.settlements.has(`${run.marketId}:${run.batchId}`)) continue;
      if (!run.intentCommitments?.length) throw new Error("funding depth has an unknown pending settlement");
      const inputs = batchSelectionInputs(store, run.intentCommitments);
      for (const id of inputs.intentCommitments) heldIds.add(id);
      for (const id of inputs.noteNullifiers) heldNullifiers.add(id);
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
      }).filter((intent) => !heldIds.has(intent.intentCommitment.toLowerCase()) && !heldNullifiers.has(intent.noteNullifier.toLowerCase()));
  }

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
  if (config.intervalMs % (config.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS) !== 0) {
    throw new Error("funding interval must contain whole sample buckets");
  }
}
