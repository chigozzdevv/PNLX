import type { BatchExecutionRunRecord } from "@pnlx/protocol-types";
import type { ProtocolLiquidityService } from "@/workers/protocol-liquidity/protocol-liquidity.service";

export interface BatchExecutorConfig {
  batchIdPrefix?: string;
  intervalMs: number;
  protocolLiquidity?: ProtocolLiquidityService;
  settlementsOnchainRequired?: boolean;
}

export interface RunBatchExecutorInput {
  batchIdPrefix?: string;
  marketId?: string;
  now?: number;
}

export interface BatchExecutorMarketResult {
  marketId: string;
  record: BatchExecutionRunRecord;
}

export interface BatchExecutorRunResult {
  completedAt: number;
  results: BatchExecutorMarketResult[];
  startedAt: number;
}
