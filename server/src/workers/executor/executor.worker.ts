import { ExecutorService } from "@/workers/executor/executor.service";
import { FileProtocolStore } from "@/shared/state/persistent-store";
import { dirname, join } from "node:path";

interface CreateExecutorOptions {
  matchingBackend?: "threshold-recovery" | "external-blind";
  thresholdShareNodeIds?: string[];
  thresholdShareStoreDir?: string;
  thresholdShareThreshold?: number;
  privateMatchingRequired?: boolean;
  storePath?: string;
}

export function createExecutor(options: CreateExecutorOptions = {}): ExecutorService {
  return new ExecutorService({
    matchingBackend: options.matchingBackend,
    thresholdShareNodes: options.thresholdShareNodeIds ?? ["node-a", "node-b", "node-c"],
    thresholdShareStoreDir: options.thresholdShareStoreDir ??
      (options.storePath ? join(dirname(options.storePath), "threshold-shares") : undefined),
    privateMatchingRequired: options.privateMatchingRequired,
    threshold: options.thresholdShareThreshold ?? 2,
  }, options.storePath ? new FileProtocolStore(options.storePath) : undefined);
}
