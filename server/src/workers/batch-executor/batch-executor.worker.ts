import type { ExecutorService } from "../executor/executor.service";
import type { ExternalMatcherGateway } from "../external-matcher/external-matcher.model";
import type { OnchainRelay } from "../onchain/onchain.model";
import { BatchExecutorService } from "./batch-executor.service";
import type { BatchExecutorConfig } from "./batch-executor.model";

export function createBatchExecutor(
  executor: ExecutorService,
  matcher: ExternalMatcherGateway,
  config?: BatchExecutorConfig,
  onchain?: OnchainRelay,
): BatchExecutorService {
  return new BatchExecutorService(executor, matcher, config, onchain);
}
