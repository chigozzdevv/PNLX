import { hashFields } from "@pnlx/crypto";
import type { BatchExecutionPhase, BatchExecutionRunRecord, Hex } from "@pnlx/protocol-types";
import type { OnchainRelay, OnchainRelayResult } from "@/workers/onchain/onchain.model";
import type { ExecutorService } from "@/workers/executor/executor.service";
import type { MatcherGateway } from "@/workers/matcher/matcher.model";
import type { MakerLiquidityService } from "@/workers/maker-liquidity/maker-liquidity.service";
import type {
  BatchExecutorConfig,
  BatchExecutorMarketResult,
  BatchExecutorRunResult,
  RunBatchExecutorInput,
} from "@/workers/batch-executor/batch-executor.model";

const DEFAULT_BATCH_INTERVAL_MS = 5_000;
const DEFAULT_BATCH_PREFIX = "auto";
const FAILED_BATCH_RETRY_COOLDOWN_MS = 60_000;
const DEFAULT_ORACLE_REFRESH_INTERVAL_MS = 60_000;

class BatchPhaseError extends Error {
  constructor(
    readonly phase: BatchExecutionPhase,
    cause: unknown,
  ) {
    super(`${phase}: ${errorMessage(cause)}`);
    this.name = "BatchPhaseError";
  }
}

export class BatchExecutorService {
  private failedBatchRetryAfter = new Map<string, number>();
  private oracleRefreshAfter = new Map<string, number>();
  private oracleRefreshInFlight = new Map<string, Promise<void>>();
  private oracleRefreshQueue: Promise<void> = Promise.resolve();
  private oracleRefreshRunning = false;
  private oracleTimer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly executor: ExecutorService,
    private readonly matcher: MatcherGateway,
    private readonly config: BatchExecutorConfig = {
      intervalMs: DEFAULT_BATCH_INTERVAL_MS,
    },
    private readonly onchain?: OnchainRelay,
    private readonly makerLiquidity?: MakerLiquidityService,
  ) {}

  async runOnce(input: RunBatchExecutorInput = {}): Promise<BatchExecutorRunResult> {
    const startedAt = input.now ?? Date.now();
    const markets = this.marketIds(input.marketId)
      .filter((marketId) => !this.isCoolingDown(marketId, startedAt, input));
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
    this.startOracleRefresh();
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      void this.runOnce(input).finally(() => {
        this.running = false;
      });
    }, this.config.intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
    if (this.oracleTimer) clearInterval(this.oracleTimer);
    this.oracleTimer = undefined;
  }

  private startOracleRefresh(): void {
    if (!this.config.refreshMarketOracle || this.oracleTimer) return;
    const refresh = async () => {
      if (this.oracleRefreshRunning) return;
      this.oracleRefreshRunning = true;
      const now = Date.now();
      try {
        for (const marketId of this.executor.store.markets.keys()) {
          try {
            await this.refreshMarketOracleIfNeeded(marketId, now);
          } catch (error) {
            console.error(`[BatchExecutorService] oracle refresh failed for ${marketId}: ${errorMessage(error)}`);
          }
        }
      } finally {
        this.oracleRefreshRunning = false;
      }
    };
    void refresh();
    this.oracleTimer = setInterval(
      () => void refresh(),
      this.config.oracleRefreshIntervalMs ?? DEFAULT_ORACLE_REFRESH_INTERVAL_MS,
    );
    (this.oracleTimer as { unref?: () => void }).unref?.();
  }

  private async runMarket(
    marketId: string,
    startedAt: number,
    input: RunBatchExecutorInput,
  ): Promise<BatchExecutorMarketResult> {
    const batchId = this.batchIdForMarket(marketId, startedAt, input);
    const currentRunId = runId(batchId, marketId, startedAt);
    try {
      await this.progress({
        batchId,
        marketId,
        phase: "matcher",
        runId: currentRunId,
        startedAt,
        status: "running",
        updatedAt: Date.now(),
      });
      await runPhase("matcher", () => this.assertPositionRootSynchronized());
      await runPhase("oracle", () => this.refreshMarketOracleIfNeeded(marketId, startedAt));
      await runPhase("maker-liquidity", () => this.makerLiquidity?.ensureForMarket({ batchId, marketId }));
      await runPhase("maker-liquidity", () => flushStore(this.executor.store));
      await runPhase("oracle", () => this.config.sampleFundingPremium?.(marketId, startedAt));
      await this.progress({
        batchId,
        marketId,
        phase: "proving",
        runId: currentRunId,
        startedAt,
        status: "running",
        updatedAt: Date.now(),
      });
      const transcript = await runPhase("proving", () =>
        this.matcher.createSettlementTranscript({
          batchId,
          includeOpenMarketOrders: true,
          intentCommitments: this.activeIntentCommitments(marketId),
          marketId,
        })
      );
      await this.progress({
        batchId,
        marketId,
        phase: "batch-settlement",
        runId: currentRunId,
        settlementDigest: transcript.settlement.settlementDigest,
        startedAt,
        status: "running",
        updatedAt: Date.now(),
      });
      const alreadySettledOnchain = await this.isSettledOnchain(transcript.settlement);
      const relay = alreadySettledOnchain
        ? undefined
        : await runPhase("batch-settlement", () => this.trySettleOnchain(transcript.settlement));
      const proofVerified = alreadySettledOnchain || hasSubmittedProofVerification(relay);
      if (this.config.settlementsOnchainRequired && !proofVerified) {
        throw new Error("settlements require on-chain relay");
      }
      const settledTranscript = withOnchainTransactions(transcript, relay);
      const settlement = await runPhase("settlement-commit", () =>
        this.executor.commitExternalBatchSettlement(settledTranscript, {
          proofVerified: proofVerified || !this.config.settlementsOnchainRequired,
        })
      );
      await this.progress({
        batchId,
        marketId,
        phase: "maker-finalize",
        runId: currentRunId,
        settlementDigest: settlement.settlementDigest,
        startedAt,
        status: "running",
        updatedAt: Date.now(),
      });
      await runPhase("maker-finalize", () => this.makerLiquidity?.finalizeSettlement(settlement));
      await runPhase("maker-finalize", () => flushStore(this.executor.store));
      return this.record({
        aggregateVolume: settlement.aggregateVolume,
        batchId,
        completedAt: Date.now(),
        fillCount: settlement.fillCount,
        marketId,
        runId: currentRunId,
        settlementDigest: settlement.settlementDigest,
        startedAt,
        status: "settled",
      });
    } catch (error) {
      const phase = error instanceof BatchPhaseError ? error.phase : undefined;
      const reason = error instanceof Error ? error.message : "batch execution failed";
      if (!shouldSkip(reason)) {
        this.failedBatchRetryAfter.set(batchId, Date.now() + FAILED_BATCH_RETRY_COOLDOWN_MS);
      }
      return this.record({
        batchId,
        completedAt: Date.now(),
        marketId,
        phase,
        reason,
        runId: currentRunId,
        startedAt,
        status: shouldSkip(reason) ? "skipped" : "failed",
      });
    }
  }

  private record(record: BatchExecutionRunRecord): BatchExecutorMarketResult {
    this.executor.store.upsertBatchExecutionRun(record);
    return {
      marketId: record.marketId,
      record,
    };
  }

  private async progress(record: BatchExecutionRunRecord): Promise<void> {
    this.executor.store.upsertBatchExecutionRun(record);
    await flushStore(this.executor.store);
  }

  private async trySettleOnchain(
    settlement: Parameters<NonNullable<OnchainRelay>["settleBatch"]>[0],
  ): Promise<OnchainRelayResult | undefined> {
    try {
      if (this.onchain?.settleBatchAsync) {
        return await this.onchain.settleBatchAsync(settlement);
      }
      return this.onchain?.settleBatch(settlement);
    } catch (error) {
      if (this.config.settlementsOnchainRequired) throw error;
      return undefined;
    }
  }

  private async isSettledOnchain(
    settlement: Parameters<NonNullable<OnchainRelay>["settleBatch"]>[0],
  ): Promise<boolean> {
    try {
      if (this.onchain?.isBatchSettledAsync) {
        return await this.onchain.isBatchSettledAsync(settlement.batchId, settlement.marketId);
      }
      return Boolean(this.onchain?.isBatchSettled?.(settlement.batchId, settlement.marketId));
    } catch {
      return false;
    }
  }

  private async assertPositionRootSynchronized(): Promise<void> {
    if (
      !this.config.settlementsOnchainRequired ||
      (!this.onchain?.positionRootAsync && !this.onchain?.positionRoot)
    ) return;
    const localRoot = this.executor.store.positionMembershipRoot();
    const onchainRoot = this.onchain.positionRootAsync
      ? await this.onchain.positionRootAsync()
      : this.onchain.positionRoot!();
    if (localRoot.toLowerCase() !== onchainRoot.toLowerCase()) {
      throw new Error(`position root out of sync: local ${localRoot}, on-chain ${onchainRoot}`);
    }
  }

  private async refreshMarketOracleIfNeeded(marketId: string, now: number): Promise<void> {
    if (!this.config.refreshMarketOracle) return;
    const retryAfter = this.oracleRefreshAfter.get(marketId);
    if (retryAfter && retryAfter > now) return;
    const active = this.oracleRefreshInFlight.get(marketId);
    if (active) return active;
    const refresh = this.oracleRefreshQueue
      .then(() => this.config.refreshMarketOracle?.(marketId))
      .then(() => {
        this.oracleRefreshAfter.set(
          marketId,
          now + (this.config.oracleRefreshIntervalMs ?? DEFAULT_ORACLE_REFRESH_INTERVAL_MS),
        );
      })
      .finally(() => this.oracleRefreshInFlight.delete(marketId));
    this.oracleRefreshQueue = refresh.catch(() => undefined);
    this.oracleRefreshInFlight.set(marketId, refresh);
    return refresh;
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

  private activeIntentCommitments(marketId: string): Hex[] {
    return [...this.executor.store.orderLifecycle.values()]
      .filter((order) =>
        order.marketId === marketId &&
        (order.status === "open" || order.status === "partially-filled")
      )
      .map((order) => order.intentCommitment)
      .sort();
  }

  private batchIdForMarket(
    marketId: string,
    startedAt: number,
    input: RunBatchExecutorInput,
  ): string {
    const prefix = input.batchIdPrefix ?? this.config.batchIdPrefix ?? DEFAULT_BATCH_PREFIX;
    if (input.now !== undefined) return `${prefix}-${marketId}-${startedAt}`;

    const clientOrderIds = [...this.executor.store.orderLifecycle.values()]
      .filter((order) =>
        order.marketId === marketId &&
        (order.status === "open" || order.status === "partially-filled") &&
        !order.batchId.startsWith("maker-auto-")
      )
      .map((order) => order.intentCommitment)
      .sort();
    if (clientOrderIds.length === 0) return `${prefix}-${marketId}-${startedAt}`;

    const fingerprint = hashFields("batch-active-orders", [marketId, ...clientOrderIds]).slice(2, 18);
    return `${prefix}-${marketId}-${fingerprint}`;
  }

  private isCoolingDown(
    marketId: string,
    startedAt: number,
    input: RunBatchExecutorInput,
  ): boolean {
    const batchId = this.batchIdForMarket(marketId, startedAt, input);
    const retryAfter = this.failedBatchRetryAfter.get(batchId);
    if (!retryAfter) return false;
    if (retryAfter <= Date.now()) {
      this.failedBatchRetryAfter.delete(batchId);
      return false;
    }
    return true;
  }
}

function withOnchainTransactions(
  transcript: Parameters<ExecutorService["commitExternalBatchSettlement"]>[0],
  result: OnchainRelayResult | undefined,
): Parameters<ExecutorService["commitExternalBatchSettlement"]>[0] {
  const {
    proofVerificationTxHash: _untrustedProofTxHash,
    settlementTxHash: _untrustedSettlementTxHash,
    ...verifiedSettlement
  } = transcript.settlement;
  const proofVerificationTxHash = result?.relays.find(
    (relay) => relay.functionName === "verify_and_record" && relay.submitted,
  )?.txHash;
  const settlementTxHash = result?.relays.find(
    (relay) => relay.functionName === "settle" && relay.kind === "batch-settlement" && relay.submitted,
  )?.txHash;
  return {
    ...transcript,
    settlement: {
      ...verifiedSettlement,
      ...(proofVerificationTxHash ? { proofVerificationTxHash } : {}),
      ...(settlementTxHash ? { settlementTxHash } : {}),
    },
  };
}

async function runPhase<T>(
  phase: BatchExecutionPhase,
  task: () => Promise<T> | T,
): Promise<T> {
  try {
    return await task();
  } catch (error) {
    throw new BatchPhaseError(phase, error);
  }
}

async function flushStore(store: unknown): Promise<void> {
  if (store && typeof store === "object" && "flush" in store && typeof store.flush === "function") {
    await (store as { flush(): Promise<void> }).flush();
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
    "private match payload not found",
    "account encryption key not found",
  ].some((message) => reason.includes(message));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
