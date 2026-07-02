import { hashFields } from "@pnlx/crypto";
import type { Hex, LiquidationAutomationJobRecord } from "@pnlx/protocol-types";
import type { ExecutorService } from "@/workers/executor/executor.service";
import type { LiquidationsService } from "@/features/liquidations/liquidations.service";
import type {
  EnqueueLiquidationJobInput,
  LiquidationAutomationRunResult,
  RunLiquidationAutomationInput,
} from "@/features/liquidation-automation/liquidation-automation.model";

const DEFAULT_INTERVAL_MS = 5_000;

export class LiquidationAutomationService {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly executor: ExecutorService,
    private readonly liquidations: LiquidationsService,
    private readonly config: { intervalMs?: number } = {},
  ) {}

  enqueue(input: EnqueueLiquidationJobInput): LiquidationAutomationJobRecord {
    const now = Date.now();
    const job: LiquidationAutomationJobRecord = {
      createdAt: now,
      jobId: liquidationJobId(input.liquidation),
      liquidation: input.liquidation,
      marketId: input.liquidation.marketId,
      positionCommitment: input.liquidation.positionCommitment,
      positionNullifier: input.liquidation.positionNullifier,
      rewardCommitment: input.liquidation.rewardCommitment,
      status: "pending",
      updatedAt: now,
    };
    this.executor.store.addLiquidationAutomationJob(job);
    return job;
  }

  list(): LiquidationAutomationJobRecord[] {
    return [...this.executor.store.liquidationAutomationJobs.values()]
      .sort((a, b) => a.createdAt - b.createdAt || a.jobId.localeCompare(b.jobId));
  }

  runOnce(input: RunLiquidationAutomationInput = {}): LiquidationAutomationRunResult {
    const startedAt = input.now ?? Date.now();
    const jobs = this.list().filter((job) =>
      job.status === "pending" && (!input.marketId || job.marketId === input.marketId),
    );
    const results = jobs.map((job) => this.runJob(job));
    return {
      completedAt: Date.now(),
      jobs: results,
      startedAt,
    };
  }

  start(input: Omit<RunLiquidationAutomationInput, "now"> = {}): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runOnce(input);
    }, this.config.intervalMs ?? DEFAULT_INTERVAL_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private runJob(job: LiquidationAutomationJobRecord) {
    try {
      this.liquidations.createProven(job.liquidation);
      const updated = {
        ...job,
        executedAt: Date.now(),
        status: "executed" as const,
        updatedAt: Date.now(),
      };
      this.executor.store.updateLiquidationAutomationJob(updated);
      return { job: updated, status: updated.status };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "liquidation automation failed";
      const status = isStaleLiquidationReason(reason) ? "stale" as const : "failed" as const;
      const updated = {
        ...job,
        failedAt: Date.now(),
        reason,
        status,
        updatedAt: Date.now(),
      };
      this.executor.store.updateLiquidationAutomationJob(updated);
      return { job: updated, reason, status };
    }
  }
}

function liquidationJobId(record: EnqueueLiquidationJobInput["liquidation"]): Hex {
  return hashFields("liquidation-automation-job", [
    record.marketId,
    record.positionCommitment,
    record.positionNullifier,
    record.rewardCommitment,
    record.proof.proofDigest,
  ]);
}

function isStaleLiquidationReason(reason: string): boolean {
  return [
    "liquidation mark price mismatch",
    "liquidation maintenance rate mismatch",
    "position root is not current",
  ].some((message) => reason.includes(message));
}
