import type { BatchExecutionRunRecord } from "@pnlx/protocol-types";

export interface BatchExecutorConfig {
  batchIdPrefix?: string;
  intervalMs: number;
  oracleRefreshIntervalMs?: number;
  oracleRefreshTimeoutMs?: number;
  refreshMarketOracle?: (marketId: string, signal?: AbortSignal) => Promise<void> | void;
  sampleFundingPremium?: (marketId: string, sampledAt: number) => Promise<void> | void;
  settlementsOnchainRequired?: boolean;
}

export interface RunBatchExecutorInput {
  batchIdPrefix?: string;
  marketId?: string;
  now?: number;
}

export interface BatchExecutorMarketResult {
  marketId: string;
  record: Omit<BatchExecutionRunRecord, "intentCommitments" | "settlementTranscript">;
}

export interface BatchExecutorRunResult {
  completedAt: number;
  results: BatchExecutorMarketResult[];
  startedAt: number;
}
