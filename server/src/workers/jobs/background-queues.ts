import { Queue, Worker, type ConnectionOptions, type JobsOptions } from "bullmq";
import type { BatchExecutorService } from "@/workers/batch-executor/batch-executor.service";
import type { LiquidationAutomationService } from "@/features/liquidation-automation/liquidation-automation.service";

interface BackgroundJobQueueInput {
  batchExecutor: BatchExecutorService;
  batchExecutorEnabled: boolean;
  batchExecutorIntervalMs: number;
  batchExecutorPrefix: string;
  liquidationAutomation: LiquidationAutomationService;
  liquidationAutomationEnabled: boolean;
  liquidationAutomationIntervalMs: number;
  redisUrl: string;
}

export interface BackgroundJobQueues {
  close(): Promise<void>;
}

export function startBackgroundJobQueues(input: BackgroundJobQueueInput): BackgroundJobQueues {
  if (!input.redisUrl) throw new Error("REDIS_URL is required when JOB_QUEUE_DRIVER=bullmq");

  const connection = redisConnection(input.redisUrl);
  const batchWorkerConnection = redisConnection(input.redisUrl);
  const liquidationWorkerConnection = redisConnection(input.redisUrl);
  const prefix = "pnlx";
  const batchQueue = new Queue("batch-executor", { connection, prefix });
  const liquidationQueue = new Queue("liquidation-automation", { connection, prefix });
  const batchWorker = new Worker(
    "batch-executor",
    async (job) => {
      await input.batchExecutor.runOnce({
        batchIdPrefix: job.data.batchIdPrefix,
        marketId: job.data.marketId,
      });
    },
    { connection: batchWorkerConnection, prefix },
  );
  const liquidationWorker = new Worker(
    "liquidation-automation",
    async (job) => {
      input.liquidationAutomation.runOnce({
        marketId: job.data.marketId,
      });
    },
    { connection: liquidationWorkerConnection, prefix },
  );

  if (input.batchExecutorEnabled) {
    void scheduleRepeatable(batchQueue, "run", {
      batchIdPrefix: input.batchExecutorPrefix,
    }, input.batchExecutorIntervalMs);
  }
  if (input.liquidationAutomationEnabled) {
    void scheduleRepeatable(liquidationQueue, "run", {}, input.liquidationAutomationIntervalMs);
  }

  return {
    async close() {
      await Promise.all([
        batchWorker.close(),
        liquidationWorker.close(),
        batchQueue.close(),
        liquidationQueue.close(),
      ]);
    },
  };
}

function redisConnection(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  const db = url.pathname && url.pathname !== "/" ? Number(url.pathname.slice(1)) : undefined;
  return {
    db,
    host: url.hostname,
    maxRetriesPerRequest: null,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    port: url.port ? Number(url.port) : 6379,
    username: url.username ? decodeURIComponent(url.username) : undefined,
  };
}

async function scheduleRepeatable(
  queue: Queue,
  name: string,
  data: Record<string, unknown>,
  every: number,
): Promise<void> {
  const options: JobsOptions = {
    jobId: `${queue.name}:${name}`,
    removeOnComplete: true,
    removeOnFail: 100,
    repeat: {
      every,
    },
  };
  await queue.add(name, data, options);
}
