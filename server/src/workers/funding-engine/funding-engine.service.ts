import { fundingIndexDelta } from "@merkl/market-math";
import type { FundingUpdateRecord, MarketConfig } from "@merkl/protocol-types";
import type { OnchainRelay, OnchainRelayResult } from "../onchain/onchain.model";
import type { Prover } from "../prover/prover.model";
import type { ExecutorService } from "../executor/executor.service";
import { assertSubmittedRelay } from "../../shared/protocol/onchain-submission";
import type {
  FundingCycleMarketResult,
  FundingCycleResult,
  FundingEngineConfig,
  RunFundingCycleInput,
} from "./funding-engine.model";

const DEFAULT_FUNDING_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_PREMIUM_RATE = 0n;

export class FundingEngineService {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly executor: ExecutorService,
    private readonly config: FundingEngineConfig = {
      intervalMs: DEFAULT_FUNDING_INTERVAL_MS,
      premiumRate: DEFAULT_PREMIUM_RATE,
    },
    private readonly prover?: Prover,
    private readonly onchain?: OnchainRelay,
  ) {}

  runOnce(input: RunFundingCycleInput = {}): FundingCycleResult {
    const appliedAt = input.appliedAt ?? Date.now();
    const markets = this.markets(input.marketId);
    return {
      appliedAt,
      results: markets.map((market) => this.runMarket(market, appliedAt, input)),
    };
  }

  start(input: Omit<RunFundingCycleInput, "appliedAt" | "elapsedMs"> = {}): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.runOnce(input);
    }, this.config.intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
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

    const fundingDelta = fundingIndexDelta({
      elapsedMs,
      intervalMs: this.config.intervalMs,
      markPrice: market.oraclePrice,
      maxFundingDelta: input.maxFundingDelta ?? this.config.maxFundingDelta,
      premiumRate: input.premiumRate ?? this.config.premiumRate,
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
        premiumRate: input.premiumRate ?? this.config.premiumRate,
      });
      const relay = this.onchain.settleFunding(settlement);
      this.assertSubmittedSettlementRelay(relay);
    } else if (this.config.settlementsOnchainRequired) {
      throw new Error("settlements require on-chain relay");
    }

    const update = this.applyFunding(market, fundingDelta, appliedAt);
    return {
      elapsedMs,
      marketId: market.marketId,
      skipped: false,
      update,
    };
  }

  private applyFunding(
    market: MarketConfig,
    fundingDelta: bigint,
    appliedAt: number,
  ): FundingUpdateRecord {
    if (fundingDelta === 0n) throw new Error("funding delta cannot be zero");
    const record: FundingUpdateRecord = {
      appliedAt,
      fundingDelta,
      marketId: market.marketId,
      newFundingIndex: market.fundingIndex + fundingDelta,
      oldFundingIndex: market.fundingIndex,
    };
    this.executor.store.updateMarket({
      ...market,
      fundingIndex: record.newFundingIndex,
    });
    this.executor.store.addFundingUpdate(record);
    return record;
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
