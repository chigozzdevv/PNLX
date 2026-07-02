import type {
  AccountEventRecord,
  BatchSettlement,
  IntentRecord,
  IntentValidityRecord,
  MarketConfig,
  PositionLifecycleRecord,
  ResidualOrderRecord,
  TradeIntent,
} from "@pnlx/protocol-types";
import type { NodeShareSet } from "@/workers/threshold-shares/threshold-shares.model";

export interface ExecutorConfig {
  matchingBackend?: "threshold-recovery" | "external-blind";
  thresholdShareNodes: string[];
  thresholdShareStoreDir?: string;
  privateMatchingRequired?: boolean;
  threshold: number;
}

export interface SubmitIntentInput {
  intent: TradeIntent;
  validity: IntentValidityRecord;
}

export interface SubmitSharedIntentInput {
  record: IntentRecord;
  shareSets: NodeShareSet[];
}

export interface PreparedIntentSubmission {
  record: IntentRecord;
  shareSets: NodeShareSet[];
}

export interface SettleBatchInput {
  batchId: string;
  marketId: string;
}

export interface ExternalBatchSettlementTranscript {
  accountEvents: AccountEventRecord[];
  positionOpenings: PositionLifecycleRecord[];
  residualOrders?: ResidualOrderRecord[];
  settlement: BatchSettlement;
}

export interface ExternalBatchSettlementCommitOptions {
  proofVerified?: boolean;
}

export interface PnlxExecutor {
  addMarket(market: MarketConfig): void;
  prepareIntent(input: SubmitIntentInput): PreparedIntentSubmission;
  commitPreparedIntent(input: PreparedIntentSubmission): IntentRecord;
  prepareSharedIntent(input: SubmitSharedIntentInput): PreparedIntentSubmission;
  commitPreparedSharedIntent(input: PreparedIntentSubmission): IntentRecord;
  submitIntent(input: SubmitIntentInput): IntentRecord;
  submitSharedIntent(input: SubmitSharedIntentInput): IntentRecord;
  settleBatch(input: SettleBatchInput): BatchSettlement;
}
