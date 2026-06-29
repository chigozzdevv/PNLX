import { ExecutorService } from "./executor.service";
import { FileProtocolStore } from "../../shared/state/persistent-store";
import { dirname, join } from "node:path";

interface CreateExecutorOptions {
  matchingBackend?: "threshold-recovery" | "external-blind";
  mpcNodeIds?: string[];
  mpcShareStoreDir?: string;
  mpcThreshold?: number;
  privateMatchingRequired?: boolean;
  storePath?: string;
}

export function createExecutor(options: CreateExecutorOptions = {}): ExecutorService {
  return new ExecutorService({
    matchingBackend: options.matchingBackend,
    mpcNodes: options.mpcNodeIds ?? ["node-a", "node-b", "node-c"],
    mpcShareStoreDir: options.mpcShareStoreDir ??
      (options.storePath ? join(dirname(options.storePath), "mpc-shares") : undefined),
    privateMatchingRequired: options.privateMatchingRequired,
    threshold: options.mpcThreshold ?? 2,
  }, options.storePath ? new FileProtocolStore(options.storePath) : undefined);
}
