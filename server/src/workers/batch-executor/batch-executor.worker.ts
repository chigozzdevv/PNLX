import type { ExecutorService } from "@/workers/executor/executor.service";
import type { MatcherGateway } from "@/workers/matcher/matcher.model";
import type { OnchainRelay } from "@/workers/onchain/onchain.model";
import { BatchExecutorService } from "@/workers/batch-executor/batch-executor.service";
import type { BatchExecutorConfig } from "@/workers/batch-executor/batch-executor.model";

export function createBatchExecutor(
  executor: ExecutorService,
  matcher: MatcherGateway,
  config?: BatchExecutorConfig,
  onchain?: OnchainRelay,
): BatchExecutorService {
  return new BatchExecutorService(executor, matcher, config, onchain);
}
