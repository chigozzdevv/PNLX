import { ExecutorService } from "@/workers/executor/executor.service";
import { MongoProtocolStore, type MongoProtocolStoreOptions } from "@/shared/mongo/store";

interface CreateExecutorOptions {
  mongo?: MongoProtocolStoreOptions;
  privateMatchingRequired?: boolean;
}

export function createExecutor(options: CreateExecutorOptions = {}): ExecutorService {
  return new ExecutorService({
    privateMatchingRequired: options.privateMatchingRequired,
  });
}

export async function createExecutorAsync(options: CreateExecutorOptions = {}): Promise<ExecutorService> {
  if (options.mongo) {
    return new ExecutorService({
      privateMatchingRequired: options.privateMatchingRequired,
    }, await MongoProtocolStore.connect(options.mongo));
  }
  return createExecutor(options);
}
