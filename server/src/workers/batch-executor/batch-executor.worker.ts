import type { ExecutorService } from "../executor/executor.service";
import type { MatcherGateway } from "../matcher/matcher.model";
import type { OnchainRelay } from "../onchain/onchain.model";
import { BatchExecutorService } from "./batch-executor.service";
import type { BatchExecutorConfig } from "./batch-executor.model";

export function createBatchExecutor(
  executor: ExecutorService,
  matcher: MatcherGateway,
  config?: BatchExecutorConfig,
  onchain?: OnchainRelay,
): BatchExecutorService {
  return new BatchExecutorService(executor, matcher, config, onchain);
}
