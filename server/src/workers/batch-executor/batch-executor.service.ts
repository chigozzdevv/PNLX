import { assertPositionMutationReady, withPositionMutation } from "@/shared/protocol/position-mutation";
import { hashFields } from "@pnlx/crypto";
import type { BatchExecutionPhase, BatchExecutionRunRecord, BatchSettlement, Hex } from "@pnlx/protocol-types";
import { batchSelectionFullyConsumes, batchSelectionInputs, capacityBoundedIntentCommitments, type BatchSelectionExclusions } from "@/workers/batch-executor/batch-capacity";
import { assertBatchExecutionBudget } from "@/shared/protocol/batch-budget";
import type { OnchainRelay, OnchainRelayResult } from "@/workers/onchain/onchain.model";
import type { ExecutorService } from "@/workers/executor/executor.service";
import type { ExternalBatchSettlementTranscript } from "@/workers/executor/executor.model";
import type { MatcherGateway } from "@/workers/matcher/matcher.model";
import type { MakerLiquidityService } from "@/workers/maker-liquidity/maker-liquidity.service";
import type {
  BatchExecutorConfig,
  BatchExecutorMarketResult,
  BatchExecutorRunResult,
  RunBatchExecutorInput,
} from "@/workers/batch-executor/batch-executor.model";

type BatchExecutionRunUpdate = BatchExecutionRunRecord & {
  intentCommitments: Hex[];
};
type BatchExecutionContext = Pick<BatchExecutionRunUpdate,
  "batchId" | "marketId" | "runId" | "startedAt" | "intentCommitments">;

const DEFAULT_BATCH_INTERVAL_MS = 5_000;
const DEFAULT_BATCH_PREFIX = "auto";
const FAILED_BATCH_RETRY_COOLDOWN_MS = 60_000;
const MISSING_LIQUIDITY_RETRY_COOLDOWN_MS = 30_000;
const DEFAULT_ORACLE_REFRESH_INTERVAL_MS = 60_000;
const DEFAULT_ORACLE_REFRESH_TIMEOUT_MS = 30_000;
const MARKET_RUNS = new WeakMap<object, Map<string, Promise<BatchExecutorMarketResult>>>();
const ACTIVE_RESERVATIONS = new WeakMap<object, Map<Hex, "fresh" | "recovery">>();

class StaleFundingEpochError extends Error {}

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
  private batchRetryAfter = new Map<string, number>();
  private oracleRefreshAfter = new Map<string, number>();
  private oracleRefreshInFlight = new Map<string, Promise<void>>();
  private oracleControllers = new Set<AbortController>();
  private oracleRefreshQueue: Promise<void> = Promise.resolve();
  private oracleTimer: ReturnType<typeof setInterval> | undefined;
  private readonly marketRuns: Map<string, Promise<BatchExecutorMarketResult>>;
  private readonly activeReservations: Map<Hex, "fresh" | "recovery">;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly executor: ExecutorService,
    private readonly matcher: MatcherGateway,
    private readonly config: BatchExecutorConfig = {
      intervalMs: DEFAULT_BATCH_INTERVAL_MS,
    },
    private readonly onchain?: OnchainRelay,
    private readonly makerLiquidity?: MakerLiquidityService,
  ) {
    this.marketRuns = MARKET_RUNS.get(executor.store) ?? new Map();
    MARKET_RUNS.set(executor.store, this.marketRuns);
    this.activeReservations = ACTIVE_RESERVATIONS.get(executor.store) ?? new Map();
    ACTIVE_RESERVATIONS.set(executor.store, this.activeReservations);
    if (config.proofPipelineConcurrency !== undefined && ![1, 2].includes(config.proofPipelineConcurrency)) {
      throw new Error("batch proof pipeline concurrency must be 1 or 2");
    }
    if ([config.intervalMs, config.oracleRefreshTimeoutMs, config.oracleRefreshIntervalMs]
      .some((value) => value !== undefined && (!Number.isSafeInteger(value) || value <= 0))) {
      throw new Error("invalid batch executor interval or oracle timeout");
    }
  }

  async settleRequestedBatch(input: { batchId: string; marketId: string }): Promise<BatchSettlement> {
    const committed = this.executor.store.settlements.get(`${input.marketId}:${input.batchId}`);
    if (committed) {
      await this.makerLiquidity?.finalizeSettlement(committed);
      await flushStore(this.executor.store);
      return committed;
    }
    const previous = this.runsForBatch(input.batchId, input.marketId)[0];
    if (previous?.submissionAttempted && !previous.settlementTranscript) {
      throw new Error("original settlement transcript is unavailable; explicit reconciliation required");
    }
    return this.commitExternalTranscript(previous?.settlementTranscript ??
      await this.matcher.createSettlementTranscript(input));
  }

  async commitExternalTranscript(input: ExternalBatchSettlementTranscript): Promise<BatchSettlement> {
    const snapshot = copyBatchTranscript(input);
    let context: BatchExecutionContext | undefined;
    try {
      const settlement = await withPositionMutation(this.executor.store, async () => {
        const batch = snapshot.settlement;
        const existing = this.executor.store.settlements.get(`${batch.marketId}:${batch.batchId}`);
        if (existing) {
          if (existing.settlementDigest !== batch.settlementDigest) throw new Error("conflicting settled batch digest");
          return existing;
        }
        const previous = this.runsForBatch(batch.batchId, batch.marketId)[0];
        if (previous?.submissionAttempted && !previous.settlementTranscript) {
          throw new Error("original settlement transcript is unavailable; explicit reconciliation required");
        }
        if (previous?.settlementDigest && previous.settlementDigest !== batch.settlementDigest) {
          throw new Error("conflicting batch settlement journal; reconciliation required");
        }
        if (previous?.settlementTranscript && encodeBatchTranscript(previous.settlementTranscript) !== encodeBatchTranscript(snapshot)) {
          throw new Error("conflicting batch settlement transcript; original journal retained");
        }
        const transcript = previous?.settlementTranscript ?? snapshot;
        this.executor.validateExternalBatchSettlement(transcript);
        context = { batchId: batch.batchId, marketId: batch.marketId, startedAt: previous?.startedAt ?? Date.now(),
          runId: previous?.runId ?? hashFields("requested-batch-execution-run", [batch.batchId, batch.marketId, batch.settlementDigest]),
          intentCommitments: previous?.intentCommitments ?? batch.orderUpdates.map((update) => update.intentCommitment) };
        await this.progress({ ...context, settlementDigest: batch.settlementDigest, settlementTranscript: transcript,
          phase: "batch-settlement", status: "running", updatedAt: Date.now() });
        return this.commitTranscriptSerialized(transcript, context);
      });
      await this.makerLiquidity?.finalizeSettlement(settlement);
      await flushStore(this.executor.store);
      if (context) {
        this.record({ ...context, settlementDigest: settlement.settlementDigest, aggregateVolume: settlement.aggregateVolume,
          fillCount: settlement.fillCount, status: "settled", completedAt: Date.now() });
        await flushStore(this.executor.store);
      }
      return settlement;
    } catch (error) {
      if (context) {
        const attempted = this.executor.store.batchExecutionRuns.get(context.runId)?.submissionAttempted;
        this.record({ ...context, status: error instanceof StaleFundingEpochError && !attempted ? "skipped" : "failed",
          completedAt: Date.now(), reason: errorMessage(error),
          phase: error instanceof BatchPhaseError ? error.phase : undefined });
        await flushStore(this.executor.store);
      }
      throw error;
    }
  }

  private runsForBatch(batchId: string, marketId: string): BatchExecutionRunRecord[] {
    return [...this.executor.store.batchExecutionRuns.values()]
      .filter((run) => run.batchId === batchId && run.marketId === marketId && run.settlementDigest)
      .sort((left, right) => (right.updatedAt ?? right.completedAt ?? right.startedAt) -
        (left.updatedAt ?? left.completedAt ?? left.startedAt));
  }

  async runOnce(input: RunBatchExecutorInput = {}): Promise<BatchExecutorRunResult> {
    const startedAt = input.now ?? Date.now();
    const markets = this.marketIds(input.marketId)
      .filter((marketId) => !this.isCoolingDown(marketId, startedAt, input));
    const results = await Promise.all(
      markets.map((marketId) => this.runMarketExclusive(marketId, startedAt, input)),
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
      const startedAt = Date.now();
      for (const marketId of this.marketIds(input.marketId)) {
        if (this.marketRuns.has(marketId) || this.isCoolingDown(marketId, startedAt, input)) continue;
        void this.runMarketExclusive(marketId, startedAt, input).catch((error) => {
          console.error(`[BatchExecutorService] batch failed for ${marketId}: ${errorMessage(error)}`);
        });
      }
    }, this.config.intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.oracleTimer) clearInterval(this.oracleTimer);
    this.oracleTimer = undefined;
    for (const controller of this.oracleControllers) controller.abort();
  }

  private startOracleRefresh(): void {
    if (!this.config.refreshMarketOracle || this.oracleTimer) return;
    const refresh = () => {
      const now = Date.now();
      for (const marketId of this.executor.store.markets.keys()) {
        void this.refreshMarketOracleIfNeeded(marketId, now).catch((error) => {
          console.error(`[BatchExecutorService] oracle refresh failed for ${marketId}: ${errorMessage(error)}`);
        });
      }
    };
    void refresh();
    this.oracleTimer = setInterval(
      () => void refresh(),
      this.config.oracleRefreshIntervalMs ?? DEFAULT_ORACLE_REFRESH_INTERVAL_MS,
    );
    (this.oracleTimer as { unref?: () => void }).unref?.();
  }

  private runMarketExclusive(
    marketId: string,
    startedAt: number,
    input: RunBatchExecutorInput,
  ): Promise<BatchExecutorMarketResult> {
    const active = this.marketRuns.get(marketId);
    if (active) return active;
    const work = Promise.resolve().then(() => this.runMarket(marketId, startedAt, input));
    this.marketRuns.set(marketId, work);
    void work.finally(() => {
      if (this.marketRuns.get(marketId) === work) this.marketRuns.delete(marketId);
    }).catch(() => undefined);
    return work;
  }

  private async runMarket(
    marketId: string,
    startedAt: number,
    input: RunBatchExecutorInput,
  ): Promise<BatchExecutorMarketResult> {
    const planningAt = Date.now();
    const limit = this.config.proofPipelineConcurrency ?? 2;
    const reservations: BatchExecutionRunRecord[] = [];
    const baseBatchId = this.batchIdForMarket(marketId, startedAt, input);
    try {
      await this.abandonInactiveReservations();
      const recovery = this.resumableRuns(marketId);
      if (recovery.length) {
        const uncertain = this.pendingReservations().find((record) => record.submissionAttempted &&
          !this.executor.store.settlements.has(`${record.marketId}:${record.batchId}`));
        const eligible = uncertain
          ? recovery.filter((record) => record.runId === uncertain.runId || record.settlementTranscript)
          : recovery;
        if (!eligible.length) throw new Error("uncertain settlement requires recovery before more proving");
        for (const record of eligible.slice(0, limit)) {
          reservations.push(record);
          this.activeReservations.set(record.runId, "recovery");
          this.executor.store.upsertBatchExecutionRun(this.enrichRunRecord({ ...record,
            status: "running", reason: undefined, completedAt: undefined, updatedAt: Date.now(),
          }), record.intentCommitments ?? []);
        }
      } else {
        this.assertFreshPlanningReady();
        await runPhase("matcher", () => this.assertPositionRootSynchronized());
        await runPhase("oracle", () => this.refreshMarketOracleIfNeeded(marketId, startedAt));
        await runPhase("maker-liquidity", () => this.makerLiquidity?.ensureForMarket({ batchId: baseBatchId, marketId }));
        await runPhase("maker-liquidity", () => flushStore(this.executor.store));
        await runPhase("oracle", () => this.config.sampleFundingPremium?.(marketId, startedAt));
        this.assertFreshPlanningReady();
        // Selection and in-memory reservation are synchronous, including across
        // market orchestrators sharing this store. Flush all before any prover call.
        for (let slot = 0; slot < limit; slot++) {
          if (slot > 0 && !batchSelectionFullyConsumes(this.executor.store, marketId, reservations[slot - 1]!.intentCommitments!)) break;
          const batchId = slot === 0 ? baseBatchId : `${baseBatchId}-p${slot + 1}`;
          let ids: Hex[];
          try {
            ids = capacityBoundedIntentCommitments(this.executor.store, marketId, batchId, this.reservedInputs());
          } catch (error) {
            if (slot > 0 && errorMessage(error).includes("batch has no crossed liquidity")) break;
            throw error;
          }
          if (ids.length < 2) {
            if (reservations.length) break;
            throw new Error(ids.length === 0 ? "batch has no active intents" : "batch has no crossed liquidity");
          }
          const record: BatchExecutionRunRecord = {
            batchId, marketId, runId: runId(batchId, marketId, startedAt), startedAt,
            intentCommitments: ids, phase: "proving", status: "running", updatedAt: Date.now(),
            phaseTimestamps: { matcher: planningAt },
          };
          reservations.push(record);
          this.activeReservations.set(record.runId, "fresh");
          this.executor.store.upsertBatchExecutionRun(this.enrichRunRecord(record), ids);
        }
      }
      // An already attempted mutation must be reconciled even if another old
      // proving reservation is corrupt or overlaps it. No new proof is launched
      // past that uncertainty; other jobs may only reuse an existing transcript.
      if (!this.pendingReservations().some((record) => record.submissionAttempted &&
          !this.executor.store.settlements.has(`${record.marketId}:${record.batchId}`))) {
        this.assertReservationsDisjoint();
      }
      await flushStore(this.executor.store);
      // Each preparation persists its transcript as soon as it completes, while
      // only the preceding job's successful commit permits the next settlement.
      const work: Array<Promise<BatchExecutorMarketResult>> = [];
      for (const reservation of reservations) {
        work.push(this.runReservedBatch(reservation, work.at(-1)));
      }
      const completed = await Promise.allSettled(work);
      const rejected = completed.find((result) => result.status === "rejected");
      if (rejected?.status === "rejected") throw rejected.reason;
      const results = completed.map((result) => (result as PromiseFulfilledResult<BatchExecutorMarketResult>).value);
      return results.find((result) => result.record.status === "failed") ?? results.at(-1)!;
    } catch (error) {
      const phase = error instanceof BatchPhaseError ? error.phase : "matcher";
      const reason = errorMessage(error);
      // If persistence/planning fails, already reserved selections remain held.
      const failed = reservations.flatMap((record) => {
        const current = this.executor.store.batchExecutionRuns.get(record.runId) ?? record;
        if (current.status === "settled") return [];
        return [this.record({ ...current, intentCommitments: current.intentCommitments ?? [],
          phase: current.phase, status: "failed", completedAt: Date.now(), updatedAt: Date.now(), reason })];
      });
      if (failed.length) return failed[0];
      return this.recordFailure({ batchId: baseBatchId, marketId, startedAt,
        runId: runId(baseBatchId, marketId, startedAt), intentCommitments: [] }, phase, reason);
    } finally {
      for (const record of reservations) this.activeReservations.delete(record.runId);
    }
  }

  private async runReservedBatch(
    reservation: BatchExecutionRunRecord,
    previous?: Promise<BatchExecutorMarketResult>,
  ): Promise<BatchExecutorMarketResult> {
    const { batchId, marketId, runId: currentRunId, startedAt } = reservation;
    const intentCommitments = [...(reservation.intentCommitments ?? [])];
    const context = { batchId, marketId, runId: currentRunId, startedAt, intentCommitments };
    try {
      const committed = reservation.settlementDigest && [...this.executor.store.settlements.values()].find((settlement) =>
        settlement.marketId === marketId && settlement.batchId === batchId &&
        settlement.settlementDigest === reservation.settlementDigest);
      if (committed) {
        if (previous && (await previous).record.status === "failed") throw new Error("earlier batch requires reconciliation");
        await runPhase("maker-finalize", () => this.makerLiquidity?.finalizeSettlement(committed));
        await runPhase("maker-finalize", () => flushStore(this.executor.store));
        return this.record({ ...context, settlementDigest: committed.settlementDigest,
          aggregateVolume: committed.aggregateVolume, fillCount: committed.fillCount,
          completedAt: Date.now(), status: "settled" });
      }
      if (reservation.submissionAttempted && !reservation.settlementTranscript) {
        throw new Error("original settlement transcript is unavailable; explicit reconciliation required");
      }
      if (!intentCommitments.length) throw new Error("original batch selection is unavailable; reconciliation required");
      const transcript = reservation.settlementTranscript ?? copyBatchTranscript(await runPhase("proving", () =>
        this.matcher.createSettlementTranscript({
          batchId,
          includeOpenMarketOrders: true,
          intentCommitments: [...intentCommitments],
          marketId,
        })
      ));
      if (transcript.settlement.batchId !== batchId || transcript.settlement.marketId !== marketId) {
        throw new Error("batch settlement transcript identity mismatch; reconciliation required");
      }
      if (reservation.settlementDigest && transcript.settlement.settlementDigest !== reservation.settlementDigest) {
        throw new Error("recovered batch settlement digest changed; reconciliation required");
      }
      this.assertTranscriptSelection(transcript, intentCommitments);
      await this.progress({
        batchId,
        intentCommitments,
        marketId,
        phase: "batch-settlement",
        runId: currentRunId,
        settlementDigest: transcript.settlement.settlementDigest,
        settlementTranscript: transcript,
        startedAt,
        status: "running",
        updatedAt: Date.now(),
      });
      if (previous && (await previous).record.status === "failed") {
        throw new BatchPhaseError("batch-settlement", new Error("earlier reserved batch requires reconciliation"));
      }
      await runPhase("batch-settlement", () => {
        this.assertSettlementOrdersActive(transcript.settlement);
        this.executor.validateExternalBatchSettlement?.(transcript);
      });
      const settlement = await withPositionMutation(this.executor.store, () =>
        this.commitTranscriptSerialized(transcript, { batchId, marketId, runId: currentRunId, startedAt, intentCommitments }));
      await this.progress({
        batchId,
        intentCommitments,
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
        intentCommitments,
        marketId,
        runId: currentRunId,
        settlementDigest: settlement.settlementDigest,
        startedAt,
        status: "settled",
      });
    } catch (error) {
      const phase = error instanceof BatchPhaseError ? error.phase : undefined;
      const reason = error instanceof Error ? error.message : "batch execution failed";
      const saved = this.executor.store.batchExecutionRuns.get(currentRunId);
      const result = error instanceof StaleFundingEpochError && saved && !saved.submissionAttempted
        ? this.record({ ...context, phase: phase ?? saved.phase, status: "skipped", completedAt: Date.now(),
            updatedAt: Date.now(), reason: `${reason}; unsubmitted proof retired for a fresh funding epoch` })
        : saved && await this.canAbandonReservation(saved)
        ? this.record({ ...context, phase: phase ?? saved.phase, status: "skipped", completedAt: Date.now(),
            updatedAt: Date.now(), reason: `${reason}; provably inactive input retired the unsubmitted batch` })
        : this.recordFailure(context, phase, reason);
      await flushStore(this.executor.store);
      return result;
    }
  }

  private recordFailure(context: BatchExecutionContext, phase: BatchExecutionPhase | undefined, reason: string): BatchExecutorMarketResult {
    if (!context.intentCommitments.length && /requires recovery before fresh planning|uncertain settlement requires recovery/.test(reason)) {
      const previous = [...this.executor.store.batchExecutionRuns.values()].find((record) =>
        record.marketId === context.marketId && record.batchId === context.batchId && record.status === "failed" &&
        record.phase === "matcher" && !record.intentCommitments?.length && !record.submissionAttempted);
      if (previous) context = { ...context, runId: previous.runId, startedAt: previous.startedAt };
    }
    const reserved = this.executor.store.batchExecutionRuns.get(context.runId);
    const held = Boolean(reserved?.intentCommitments?.length || reserved?.submissionAttempted);
    if (reason.includes("batch has no crossed liquidity") && !held) {
      this.batchRetryAfter.set(context.batchId, Date.now() + MISSING_LIQUIDITY_RETRY_COOLDOWN_MS);
    } else if (held || !shouldSkip(reason)) {
      this.batchRetryAfter.set(context.batchId, Date.now() + FAILED_BATCH_RETRY_COOLDOWN_MS);
    }
    return this.record({ ...context, completedAt: Date.now(), updatedAt: Date.now(), phase, reason,
      ...(phase === undefined && reserved?.phase ? { phase: reserved.phase } : {}),
      status: !held && shouldSkip(reason) ? "skipped" : "failed" });
  }

  private async commitTranscriptSerialized(
    transcript: ExternalBatchSettlementTranscript, context: BatchExecutionContext,
  ): Promise<BatchSettlement> {
    const { batchId, marketId, runId: currentRunId, startedAt, intentCommitments } = context;
    const alreadySettledOnchain = await this.isSettledOnchain(transcript.settlement);
    if (!alreadySettledOnchain) {
      await this.assertEntryFundingEpoch(transcript);
      this.assertPipelinePriority(context);
      assertBatchExecutionBudget(transcript.settlement.fillCount / 2);
      assertPositionMutationReady(this.executor.store, "batch", currentRunId);
      await runPhase("batch-settlement", () => this.assertSettlementOrdersActive(transcript.settlement));
      await runPhase("batch-settlement", () => this.assertPositionRootSynchronized());
    }
    if (this.onchain) {
      await this.progress({
        batchId, intentCommitments, marketId, runId: currentRunId, startedAt,
        phase: "batch-settlement", status: "running", updatedAt: Date.now(),
        settlementDigest: transcript.settlement.settlementDigest, submissionAttempted: true,
      });
    }
    const relay = alreadySettledOnchain
      ? undefined
      : await runPhase("batch-settlement", () => this.trySettleOnchain(transcript.settlement));
    const confirmedOnchain = alreadySettledOnchain ||
      await this.isSettledOnchain(transcript.settlement);
    if (this.config.settlementsOnchainRequired && !confirmedOnchain) {
      throw new Error("batch settlement and fee allocation are not confirmed on-chain");
    }
    const proofVerified = alreadySettledOnchain || hasSubmittedProofVerification(relay);
    if (this.config.settlementsOnchainRequired && !proofVerified) {
      throw new Error("settlements require on-chain relay");
    }
    await this.assertBatchAppendIndex(transcript.settlement);
    const settledTranscript = withOnchainTransactions(transcript, relay, confirmedOnchain);
    await this.progress({
      batchId,
      intentCommitments,
      marketId,
      phase: "settlement-commit",
      runId: currentRunId,
      settlementDigest: transcript.settlement.settlementDigest,
      startedAt,
      status: "running",
      updatedAt: Date.now(),
    });
    const committedSettlement = await runPhase("settlement-commit", () =>
      this.executor.commitExternalBatchSettlement(settledTranscript, {
        proofVerified: proofVerified || !this.config.settlementsOnchainRequired,
      })
    );
    await flushStore(this.executor.store);
    return committedSettlement;
  }

  private async assertEntryFundingEpoch(transcript: ExternalBatchSettlementTranscript): Promise<void> {
    if (!this.onchain?.enabled && !this.config.settlementsOnchainRequired) return;
    if (!this.onchain?.marketFundingIndexAsync) throw new Error("current on-chain funding index is unavailable");
    const entryIndex = transcript.settlement.entryFundingIndex;
    const currentIndex = await this.onchain.marketFundingIndexAsync(transcript.settlement.marketId);
    if (typeof entryIndex !== "bigint" || entryIndex !== currentIndex) {
      throw new StaleFundingEpochError("batch proof entry funding index is stale or unbound");
    }
    if (transcript.positionOpenings.some((position) =>
      position.marketId !== transcript.settlement.marketId || (position.fundingIndex ?? 0n) !== entryIndex)) {
      throw new Error("position opening funding index differs from its proven batch epoch");
    }
  }

  private record(update: BatchExecutionRunUpdate): BatchExecutorMarketResult {
    const { intentCommitments, ...record } = update;
    const enriched = this.enrichRunRecord(record);
    this.executor.store.upsertBatchExecutionRun({ ...enriched, intentCommitments }, intentCommitments);
    const { intentCommitments: _privateSelection, settlementTranscript: _privateTranscript, ...publicRecord } = enriched;
    return {
      marketId: enriched.marketId,
      record: publicRecord,
    };
  }

  private async progress(update: BatchExecutionRunUpdate): Promise<void> {
    const { intentCommitments, ...record } = update;
    this.executor.store.upsertBatchExecutionRun({ ...this.enrichRunRecord(record), intentCommitments }, intentCommitments);
    await flushStore(this.executor.store);
  }

  private enrichRunRecord(record: BatchExecutionRunRecord): BatchExecutionRunRecord {
    const existing = this.executor.store.batchExecutionRuns.get(record.runId);
    const phaseTimestamps = { ...existing?.phaseTimestamps, ...record.phaseTimestamps };
    if (record.phase && phaseTimestamps[record.phase] === undefined) {
      phaseTimestamps[record.phase] = record.updatedAt ?? record.completedAt ?? Date.now();
    }
    return {
      ...existing,
      ...record,
      ...(Object.keys(phaseTimestamps).length > 0 ? { phaseTimestamps } : {}),
    };
  }

  private assertSettlementOrdersActive(
    settlement: Parameters<ExecutorService["commitExternalBatchSettlement"]>[0]["settlement"],
  ): void {
    const inactive = settlement.orderUpdates
      .map((update) => update.intentCommitment)
      .filter((intentCommitment) => {
        const order = this.executor.store.orderLifecycle.get(intentCommitment);
        return !order || order.status !== "open";
      });
    if (inactive.length > 0) {
      throw new Error(`batch intent no longer active: ${inactive.join(",")}`);
    }
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
        return await this.onchain.isBatchSettledAsync(settlement.batchId, settlement.marketId, settlement.settlementDigest);
      }
      if (!this.onchain?.isBatchSettled && this.config.settlementsOnchainRequired) {
        throw new Error("missing on-chain settlement status reader");
      }
      return Boolean(this.onchain?.isBatchSettled?.(settlement.batchId, settlement.marketId, settlement.settlementDigest));
    } catch (error) {
      if (this.config.settlementsOnchainRequired) {
        throw new Error(`on-chain settlement status unavailable; reconciliation required: ${errorMessage(error)}`);
      }
      return false;
    }
  }

  private async assertBatchAppendIndex(settlement: Parameters<NonNullable<OnchainRelay>["settleBatch"]>[0]): Promise<void> {
    if (!this.config.settlementsOnchainRequired) return;
    if (!this.onchain?.batchPositionAppendIndexAsync) throw new Error("missing authoritative batch append index reader");
    const index = await this.onchain.batchPositionAppendIndexAsync(settlement.batchId, settlement.marketId);
    if (!Number.isSafeInteger(index) || index < 0 || index !== this.executor.store.positionCommitments.size) {
      throw new Error(`batch position append index is out of order: chain ${index}, local ${this.executor.store.positionCommitments.size}; reconciliation required`);
    }
  }

  private async assertPositionRootSynchronized(): Promise<void> {
    if (!this.config.settlementsOnchainRequired) return;
    if (!this.onchain?.positionRootAsync && !this.onchain?.positionRoot) {
      throw new Error("missing on-chain position root reader");
    }
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
    const controller = new AbortController();
    this.oracleControllers.add(controller);
    let underlying: Promise<void> | undefined;
    const clear = () => {
      this.oracleControllers.delete(controller);
      if (this.oracleRefreshInFlight.get(marketId) === refresh) this.oracleRefreshInFlight.delete(marketId);
    };
    const refresh = this.oracleRefreshQueue.then(() => {
      controller.signal.throwIfAborted();
      underlying = Promise.resolve()
        .then(() => this.config.refreshMarketOracle?.(marketId, controller.signal))
        .then(() => {
          controller.signal.throwIfAborted();
          this.oracleRefreshAfter.set(
            marketId,
            now + (this.config.oracleRefreshIntervalMs ?? DEFAULT_ORACLE_REFRESH_INTERVAL_MS),
          );
        });
      // A timeout advances the queue, but this market stays locked until its writer stops.
      void underlying.finally(clear).catch(() => undefined);
      return withDeadline(underlying, this.config.oracleRefreshTimeoutMs ?? DEFAULT_ORACLE_REFRESH_TIMEOUT_MS,
        () => controller.abort(), "oracle refresh deadline exceeded");
    });
    void refresh.finally(() => { if (!underlying) clear(); }).catch(() => undefined);
    this.oracleRefreshQueue = refresh.catch(() => undefined);
    this.oracleRefreshInFlight.set(marketId, refresh);
    return refresh;
  }

  private pendingReservations(): BatchExecutionRunRecord[] {
    return [...this.executor.store.batchExecutionRuns.values()]
      .filter((record) => {
        if (record.status !== "running" && record.status !== "failed") return false;
        return Boolean(record.submissionAttempted || record.settlementDigest ||
          (record.phase === "proving" && record.intentCommitments?.length));
      })
      .sort((a, b) => Number(Boolean(b.submissionAttempted)) - Number(Boolean(a.submissionAttempted)) ||
        a.startedAt - b.startedAt || a.batchId.localeCompare(b.batchId) || a.runId.localeCompare(b.runId));
  }

  private resumableRuns(marketId: string): BatchExecutionRunRecord[] {
    return this.pendingReservations().filter((record) => record.marketId === marketId);
  }

  private resumableRun(marketId: string): BatchExecutionRunRecord | undefined {
    return this.resumableRuns(marketId)[0];
  }

  private async abandonInactiveReservations(): Promise<void> {
    for (const record of this.pendingReservations()) {
      if (this.activeReservations.has(record.runId)) continue;
      if (await this.canAbandonReservation(record)) {
        const current = this.executor.store.batchExecutionRuns.get(record.runId);
        if (!current || current.submissionAttempted || this.activeReservations.has(record.runId)) continue;
        this.record({ ...current, intentCommitments: current.intentCommitments ?? [],
          status: "skipped", completedAt: Date.now(), updatedAt: Date.now(),
          reason: "provably inactive input retired the unsubmitted batch" });
      }
    }
  }

  private async canAbandonReservation(record: BatchExecutionRunRecord): Promise<boolean> {
    if (record.submissionAttempted || !record.intentCommitments?.length ||
        this.executor.store.settlements.has(`${record.marketId}:${record.batchId}`)) return false;
    const stillUnattempted = () => {
      const current = this.executor.store.batchExecutionRuns.get(record.runId);
      return Boolean(current && !current.submissionAttempted &&
        !this.executor.store.settlements.has(`${record.marketId}:${record.batchId}`) &&
        current.batchId === record.batchId && current.marketId === record.marketId &&
        JSON.stringify(current.intentCommitments) === JSON.stringify(record.intentCommitments));
    };
    try { batchSelectionInputs(this.executor.store, record.intentCommitments); }
    catch { return false; }
    const inactive = record.intentCommitments.filter((id) => {
      const order = this.executor.store.orderLifecycle.get(id);
      return order && ["filled", "partially-filled", "cancelled"].includes(order.status);
    });
    if (!inactive.length) return false;
    if (!this.config.settlementsOnchainRequired && !this.onchain?.enabled) return stillUnattempted();
    for (const id of inactive) {
      const nullifier = this.executor.store.privateMatchIntents.get(id)!.noteNullifier;
      if ([...this.executor.store.settlements.values()].some((settlement) => settlement.onchainConfirmed === true &&
          (settlement.orderUpdates?.some((update) => update.intentCommitment === id) ||
            settlement.spentNullifiers?.includes(nullifier)))) return stillUnattempted();
    }
    try {
      for (const id of inactive) {
        if (await this.onchain?.isIntentCancelledAsync?.(id) === true) return stillUnattempted();
        const nullifier = this.executor.store.privateMatchIntents.get(id)!.noteNullifier;
        if (await this.onchain?.isSecureNullifierSpentAsync?.(nullifier) === true) return stillUnattempted();
      }
    } catch { /* Unknown chain state retains the exact reservation for reconciliation. */ }
    return false;
  }

  private assertFreshPlanningReady(): void {
    const unknown = this.pendingReservations().find((record) =>
      record.status === "failed" || this.activeReservations.get(record.runId) !== "fresh");
    if (unknown) throw new Error(`reserved batch ${unknown.runId} requires recovery before fresh planning`);
  }

  private reservedInputs(): BatchSelectionExclusions {
    const intentCommitments = new Set<string>();
    const noteNullifiers = new Set<string>();
    for (const record of this.pendingReservations()) {
      if (!record.intentCommitments?.length) throw new Error("reserved batch selection is unavailable; reconciliation required");
      const inputs = batchSelectionInputs(this.executor.store, record.intentCommitments);
      for (const id of inputs.intentCommitments) intentCommitments.add(id);
      for (const id of inputs.noteNullifiers) noteNullifiers.add(id);
    }
    return { intentCommitments, noteNullifiers };
  }

  private assertReservationsDisjoint(): void {
    const seenIds = new Set<string>();
    const seenNullifiers = new Set<string>();
    for (const record of this.pendingReservations()) {
      if (this.executor.store.settlements.has(`${record.marketId}:${record.batchId}`)) continue;
      if (!record.intentCommitments?.length) {
        // Legacy uncertain records may have only the exact saved transcript;
        // their own recovery rejects missing selection before any new relay.
        if (record.submissionAttempted) continue;
        throw new Error("reserved batch selection is unavailable; reconciliation required");
      }
      const inputs = batchSelectionInputs(this.executor.store, record.intentCommitments);
      if ([...inputs.intentCommitments].some((id) => seenIds.has(id)) ||
          [...inputs.noteNullifiers].some((id) => seenNullifiers.has(id))) {
        throw new Error("overlapping batch reservations; reconciliation required");
      }
      for (const id of inputs.intentCommitments) seenIds.add(id);
      for (const id of inputs.noteNullifiers) seenNullifiers.add(id);
    }
  }

  private assertTranscriptSelection(transcript: ExternalBatchSettlementTranscript, ids: Hex[]): void {
    const selected = new Set(ids.map((id) => id.toLowerCase()));
    const updates = transcript.settlement.orderUpdates.map((update) => update.intentCommitment.toLowerCase());
    const nullifiers = transcript.settlement.spentNullifiers?.map((id) => id.toLowerCase());
    const expectedNullifiers = ids.map((id) => this.executor.store.privateMatchIntents.get(id)?.noteNullifier.toLowerCase());
    if (selected.size !== ids.length || updates.length !== selected.size || new Set(updates).size !== updates.length ||
        updates.some((id) => !selected.has(id)) || !nullifiers || nullifiers.length !== ids.length ||
        new Set(nullifiers).size !== nullifiers.length || expectedNullifiers.some((id) => !id || !nullifiers.includes(id))) {
      throw new Error("batch transcript does not match reserved inputs; reconciliation required");
    }
  }

  private assertPipelinePriority(context: BatchExecutionContext): void {
    const secondSlot = /^(.*)-p2$/.exec(context.batchId);
    if (!secondSlot) return;
    const predecessors = [...this.executor.store.batchExecutionRuns.values()].filter((record) =>
      record.marketId === context.marketId && record.batchId === secondSlot[1] && record.startedAt === context.startedAt);
    if (predecessors.length !== 1 || !predecessors[0]!.intentCommitments?.length ||
        !batchSelectionFullyConsumes(this.executor.store, context.marketId, predecessors[0]!.intentCommitments!)) {
      throw new Error("earlier partial or unknown selection requires priority reconciliation before second-slot relay");
    }
  }

  private marketIds(marketId?: string): string[] {
    if (marketId) {
      if (!this.executor.store.markets.has(marketId)) throw new Error("unknown market");
      return [marketId];
    }
    const active = new Set<string>();
    for (const order of this.executor.store.orderLifecycle.values()) {
      if (order.status === "open") {
        active.add(order.marketId);
      }
    }
    for (const marketId of this.executor.store.markets.keys()) {
      if (this.resumableRun(marketId)) active.add(marketId);
    }
    const priorities = new Map<string, number>();
    for (const [index, record] of this.pendingReservations().entries()) {
      if (!priorities.has(record.marketId)) priorities.set(record.marketId, index);
    }
    return [...active].sort((a, b) => (priorities.get(a) ?? Infinity) - (priorities.get(b) ?? Infinity) || a.localeCompare(b));
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
        order.status === "open" &&
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
    const batchId = this.resumableRun(marketId)?.batchId ?? this.batchIdForMarket(marketId, startedAt, input);
    const retryAfter = this.batchRetryAfter.get(batchId);
    if (!retryAfter) return false;
    if (retryAfter <= Date.now()) {
      this.batchRetryAfter.delete(batchId);
      return false;
    }
    return true;
  }
}

function withOnchainTransactions(
  transcript: Parameters<ExecutorService["commitExternalBatchSettlement"]>[0],
  result: OnchainRelayResult | undefined,
  confirmedOnchain: boolean,
): Parameters<ExecutorService["commitExternalBatchSettlement"]>[0] {
  const {
    proofVerificationTxHash: _untrustedProofTxHash,
    settlementTxHash: _untrustedSettlementTxHash,
    onchainConfirmed: _untrustedConfirmation,
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
      onchainConfirmed: confirmedOnchain,
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

function encodeBatchTranscript(transcript: ExternalBatchSettlementTranscript): string {
  return JSON.stringify(transcript, (_key, value) => {
    if (typeof value === "bigint") return { __pnlxBigInt: value.toString() };
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]));
    }
    return value;
  });
}

function copyBatchTranscript(transcript: ExternalBatchSettlementTranscript): ExternalBatchSettlementTranscript {
  // Avoid Bun 1.3.9 structuredClone corruption for shared proof references with BigInts.
  return JSON.parse(encodeBatchTranscript(transcript), (_key, value) =>
    value && typeof value === "object" && typeof value.__pnlxBigInt === "string"
      ? BigInt(value.__pnlxBigInt) : value) as ExternalBatchSettlementTranscript;
}

function shouldSkip(reason: string): boolean {
  return [
    "batch has no active intents",
    "batch has no crossed liquidity",
    "batch intent no longer active",
    "private match payload not found",
    "account encryption key not found",
  ].some((message) => reason.includes(message));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function withDeadline<T>(
  task: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new Error(message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
