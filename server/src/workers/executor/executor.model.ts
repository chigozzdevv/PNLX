import type {
  AccountEventRecord,
  BatchSettlement,
  IntentRecord,
  IntentValidityRecord,
  MarketConfig,
  PositionLifecycleRecord,
  PrivateMatchIntent,
  ResidualOrderRecord,
  TradeIntent,
} from "@pnlx/protocol-types";

export interface ExecutorConfig {
  privateMatchingRequired?: boolean;
}

export interface SubmitIntentInput {
  intent: TradeIntent;
  validity: IntentValidityRecord;
}

export interface PreparedIntentSubmission {
  privateMatchIntent: PrivateMatchIntent;
  record: IntentRecord;
}

export interface SettleBatchInput {
  batchId: string;
  marketId: string;
}

export interface ExternalBatchSettlementTranscript {
  accountEvents: AccountEventRecord[];
  privateMatchIntents?: PrivateMatchIntent[];
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
  submitIntent(input: SubmitIntentInput): IntentRecord;
  settleBatch(input: SettleBatchInput): BatchSettlement;
}
