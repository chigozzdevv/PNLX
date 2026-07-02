import type { Hex, OrderStatus, PositionStatus } from "@pnlx/protocol-types";

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
  marketId: string;
  residualCommitment?: Hex;
  shareCommitment: Hex;
  sourceIntentCommitment?: Hex;
  status: OrderStatus;
  updatedAt: number;
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
