import { ExecutorService } from "@/workers/executor/executor.service";
import { FileProtocolStore } from "@/shared/state/persistent-store";
import { MongoProtocolStore, type MongoProtocolStoreOptions } from "@/shared/state/mongo-store";

interface CreateExecutorOptions {
  mongo?: MongoProtocolStoreOptions;
  privateMatchingRequired?: boolean;
  storePath?: string;
}

export function createExecutor(options: CreateExecutorOptions = {}): ExecutorService {
  return new ExecutorService({
    privateMatchingRequired: options.privateMatchingRequired,
  }, options.storePath ? new FileProtocolStore(options.storePath) : undefined);
}

export async function createExecutorAsync(options: CreateExecutorOptions = {}): Promise<ExecutorService> {
  if (options.mongo) {
    return new ExecutorService({
      privateMatchingRequired: options.privateMatchingRequired,
    }, await MongoProtocolStore.connect(options.mongo));
  }
  return createExecutor(options);
}
