import type { ProtocolStore } from "@/shared/state/store";
import { IndexerService } from "@/workers/indexer/indexer.service";

export function createIndexer(store: ProtocolStore): IndexerService {
  return new IndexerService(store);
}
