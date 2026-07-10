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
  cancellationTxHash?: Hex;
  createdAt: number;
  intentCommitment: Hex;
  isResidual: boolean;
  matching: OwnerOrderMatchingSnapshot;
  matchingPayloadCommitment: Hex;
  marketId: string;
  residualCommitment?: Hex;
  sourceIntentCommitment?: Hex;
  status: OrderStatus;
  submissionTxHash?: Hex;
  updatedAt: number;
}

export type OwnerOrderMatchingState =
  | "blocked"
  | "matching"
  | "proving"
  | "queued"
  | "settled"
  | "settling"
  | "waiting-liquidity";

export interface OwnerOrderMatchingSnapshot {
  batchId?: string;
  completedAt?: number;
  message: string;
  phase?: BatchExecutionPhase;
  reason?: string;
  runId?: Hex;
  state: OwnerOrderMatchingState;
  status?: "failed" | "running" | "settled" | "skipped";
}

export interface OwnerPositionSnapshot {
  batchId: string;
  boundlessRequestId?: Hex;
  closeCommitment?: Hex;
  liquidationRewardCommitment?: Hex;
  marginOutputCommitment?: Hex;
  marketId: string;
  newPositionCommitment?: Hex;
  openedAt: number;
  positionCommitment: Hex;
  proofDigest?: Hex;
  proofVerificationTxHash?: Hex;
  journalDigest?: Hex;
  settlementDigest: Hex;
  settlementTxHash?: Hex;
  sourceIntentCommitment: Hex;
  status: PositionStatus;
  updatedAt: number;
}

export type OwnerActivityKind = "account-event" | "order" | "position";

export interface OwnerActivitySnapshot {
  batchId?: string;
  boundlessRequestId?: Hex;
  dataCommitment?: Hex;
  id: Hex;
  kind: OwnerActivityKind;
  marketId?: string;
  proofDigest?: Hex;
  proofTxHash?: Hex;
  residualCommitment?: Hex;
  status?: OrderStatus | PositionStatus;
  settlementDigest?: Hex;
  timestamp: number;
  txHash?: Hex;
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
