import type { ExternalBatchSettlementTranscript } from "@/workers/executor/executor.model";

export interface SettleBatchRequest {
  batchId: string;
  marketId: string;
}

export type CommitExternalBatchSettlementRequest = ExternalBatchSettlementTranscript;
