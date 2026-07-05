import type { BatchExecutionPhase, Hex, OrderStatus, PositionStatus } from "@pnlx/protocol-types";

export interface MarketPublicSnapshot {
  aggregateVolume: string;
  conditionalCloseCount: number;
  conditionalOrderCount: number;
  fundingIndex: string;
  grossOpenInterest: string;
  initialMarginRate: string;
  liquidationCount: number;
  maintenanceMarginRate: string;
  marketId: string;
  maxLeverage: string;
  oraclePrice: string;
  pendingIntentCount: number;
  positionCloseCount: number;
  settledBatchCount: number;
}

export interface OwnerOrderSnapshot {
  batchId: string;
  createdAt: number;
  intentCommitment: Hex;
  isResidual: boolean;
  matching: OwnerOrderMatchingSnapshot;
  matchingPayloadCommitment: Hex;
  marketId: string;
  residualCommitment?: Hex;
  sourceIntentCommitment?: Hex;
  status: OrderStatus;
  updatedAt: number;
}

export type OwnerOrderMatchingState = "blocked" | "queued" | "settled" | "waiting-liquidity";

export interface OwnerOrderMatchingSnapshot {
  batchId?: string;
  completedAt?: number;
  message: string;
  phase?: BatchExecutionPhase;
  reason?: string;
  runId?: Hex;
  state: OwnerOrderMatchingState;
  status?: "failed" | "settled" | "skipped";
}

export interface OwnerPositionSnapshot {
  batchId: string;
  closeCommitment?: Hex;
  liquidationRewardCommitment?: Hex;
  marginOutputCommitment?: Hex;
  marketId: string;
  newPositionCommitment?: Hex;
  openedAt: number;
  positionCommitment: Hex;
  settlementDigest: Hex;
  sourceIntentCommitment: Hex;
  status: PositionStatus;
  updatedAt: number;
}

export type OwnerActivityKind = "account-event" | "order" | "position";

export interface OwnerActivitySnapshot {
  batchId?: string;
  dataCommitment?: Hex;
  id: Hex;
  kind: OwnerActivityKind;
  marketId?: string;
  residualCommitment?: Hex;
  status?: OrderStatus | PositionStatus;
  timestamp: number;
  updatedAt: number;
}

export interface PublicSnapshot {
  accountEventCount: number;
  batchExecutionRunCount: number;
  conditionalCloseCount: number;
  conditionalOrderCount: number;
  disclosureCount: number;
  liquidationCount: number;
  marketCount: number;
  markets: MarketPublicSnapshot[];
  marginMembershipRoot: Hex;
  marginRoot: Hex;
  positionRoot: Hex;
  positionCloseCount: number;
  positionLifecycleCount: number;
  settlementCount: number;
  spentNullifierCount: number;
}
