import { hashFields } from "@merkl/crypto";
import type { BatchExecutionRunRecord, Hex } from "@merkl/protocol-types";
import type { OnchainRelay, OnchainRelayResult } from "../onchain/onchain.model";
import type { ExecutorService } from "../executor/executor.service";
import type { MatcherGateway } from "../matcher/matcher.model";
import type {
  BatchExecutorConfig,
  BatchExecutorMarketResult,
  BatchExecutorRunResult,
  RunBatchExecutorInput,
} from "./batch-executor.model";

const DEFAULT_BATCH_INTERVAL_MS = 5_000;
const DEFAULT_BATCH_PREFIX = "auto";

export class BatchExecutorService {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly executor: ExecutorService,
    private readonly matcher: MatcherGateway,
    private readonly config: BatchExecutorConfig = {
      intervalMs: DEFAULT_BATCH_INTERVAL_MS,
    },
    private readonly onchain?: OnchainRelay,
  ) {}

  async runOnce(input: RunBatchExecutorInput = {}): Promise<BatchExecutorRunResult> {
    const startedAt = input.now ?? Date.now();
    const markets = this.marketIds(input.marketId);
    const results = await Promise.all(
      markets.map((marketId) => this.runMarket(marketId, startedAt, input)),
    );
    return {
      completedAt: Date.now(),
      results,
      startedAt,
    };
  }

  start(input: Omit<RunBatchExecutorInput, "now"> = {}): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runOnce(input);
    }, this.config.intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async runMarket(
    marketId: string,
    startedAt: number,
    input: RunBatchExecutorInput,
  ): BatchExecutorMarketResult {
    const batchId = `${input.batchIdPrefix ?? this.config.batchIdPrefix ?? DEFAULT_BATCH_PREFIX}-${marketId}-${startedAt}`;
    try {
      const transcript = await this.matcher.createSettlementTranscript({
        batchId,
        marketId,
      });
      const relay = this.onchain?.settleBatch(transcript.settlement);
      const proofVerified = hasSubmittedProofVerification(relay);
      if (this.config.settlementsOnchainRequired && !proofVerified) {
        throw new Error("settlements require on-chain relay");
      }
      const settlement = this.executor.commitExternalBatchSettlement(transcript, {
        proofVerified: proofVerified || !this.config.settlementsOnchainRequired,
      });
      return this.record({
        aggregateVolume: settlement.aggregateVolume,
        batchId,
        completedAt: Date.now(),
        fillCount: settlement.fillCount,
        marketId,
        runId: runId(batchId, marketId, startedAt),
        settlementDigest: settlement.settlementDigest,
        startedAt,
        status: "settled",
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "batch execution failed";
      return this.record({
        batchId,
        completedAt: Date.now(),
        marketId,
        reason,
        runId: runId(batchId, marketId, startedAt),
        startedAt,
        status: shouldSkip(reason) ? "skipped" : "failed",
      });
    }
  }

  private record(record: BatchExecutionRunRecord): BatchExecutorMarketResult {
    this.executor.store.addBatchExecutionRun(record);
    return {
      marketId: record.marketId,
      record,
    };
  }

  private marketIds(marketId?: string): string[] {
    if (marketId) {
      if (!this.executor.store.markets.has(marketId)) throw new Error("unknown market");
      return [marketId];
    }
    const active = new Set<string>();
    for (const order of this.executor.store.orderLifecycle.values()) {
      if (order.status === "open" || order.status === "partially-filled") {
        active.add(order.marketId);
      }
    }
    return [...active].sort();
  }
}

function hasSubmittedProofVerification(result: OnchainRelayResult | undefined): boolean {
  return Boolean(
    result?.relays.some((relay) =>
      relay.functionName === "verify_and_record" &&
      relay.submitted,
    ),
  );
}

function runId(batchId: string, marketId: string, startedAt: number): Hex {
  return hashFields("batch-execution-run", [batchId, marketId, startedAt]);
}

function shouldSkip(reason: string): boolean {
  return [
    "batch has no active intents",
    "batch has no crossed liquidity",
    "not enough shares to recover intent",
    "account encryption key not found",
  ].some((message) => reason.includes(message));
}
