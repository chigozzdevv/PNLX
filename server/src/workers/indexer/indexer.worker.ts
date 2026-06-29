import type { ProtocolStore } from "../../shared/state/store";
import { IndexerService } from "./indexer.service";

export function createIndexer(store: ProtocolStore): IndexerService {
  return new IndexerService(store);
}
