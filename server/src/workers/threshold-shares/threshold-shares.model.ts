import type {
  BatchSettlement,
  AccountEncryptionKeyRecord,
  Hex,
  IntentRecord,
  IntentShares,
  MarketConfig,
  PositionLifecycleRecord,
  ResidualOrderRecord,
  TradeIntent,
} from "@pnlx/protocol-types";

export interface ThresholdShareConfig {
  nodeIds: string[];
  shareStoreDir?: string;
  threshold: number;
}

export interface SharedIntent {
  intent: TradeIntent;
  intentCommitment: Hex;
}

export interface RecoveredIntent {
  intentCommitment: Hex;
  batchId: string;
  marketId: string;
  ownerCommitment: Hex;
  signedSize: bigint;
  limitPrice: bigint;
  margin: bigint;
  noteNullifier: Hex;
  sourceIntentCommitment?: Hex;
}

export interface NodeShareSet {
  nodeId: string;
  shares: IntentShares[];
}

export interface CommitteeMatchInput {
  batchId: string;
  market: MarketConfig;
  records: IntentRecord[];
  residuals?: ResidualOrderRecord[];
}

export interface CommitteeSettlementInput extends CommitteeMatchInput {
  accountEncryptionKeys?: AccountEncryptionKeyRecord[];
  oldRoot: Hex;
  positionCommitments: Hex[];
}

export interface CommitteeSettlementTranscript {
  positionEvents: PrivatePositionOpeningEvent[];
  positionOpenings: PositionLifecycleRecord[];
  residualOrders: ResidualOrderRecord[];
  settlement: BatchSettlement;
}

export interface PrivatePositionOpeningEvent {
  entryPrice: bigint;
  fundingIndex: bigint;
  margin: bigint;
  marketId: string;
  positionCommitment: Hex;
  positionNullifier: Hex;
  side: "long" | "short";
  size: bigint;
  sourceIntentCommitment: Hex;
}
