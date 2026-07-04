export type Hex = `0x${string}`;
export type Side = "long" | "short";

export interface ServerProofMeta {
  circuitId: string;
  circuitKey: Hex;
  circuitHash: Hex;
  verifierHash: Hex;
  publicInputHash: Hex;
  proofDigest: Hex;
  proofSystem?: "noir-ultrahonk" | "risc0-groth16";
  bytecodeHash?: Hex;
  imageId?: Hex;
  journalDigest?: Hex;
  witnessHash?: Hex;
  proofHash?: Hex;
  publicInputsHash?: Hex;
  sealDigest?: Hex;
  vkHash?: Hex;
}

export interface ServerMarketConfig {
  marketId: string;
  oraclePrice: string;
  maxLeverage: string;
  initialMarginRate: string;
  maintenanceMarginRate: string;
  fundingIndex: string;
}

export interface ServerMarketPublicSnapshot extends ServerMarketConfig {
  aggregateVolume: string;
  conditionalCloseCount: number;
  conditionalOrderCount: number;
  grossOpenInterest: string;
  liquidationCount: number;
  pendingIntentCount: number;
  positionCloseCount: number;
  settledBatchCount: number;
}

export interface ServerPublicSnapshot {
  accountEventCount: number;
  batchExecutionRunCount: number;
  conditionalCloseCount: number;
  conditionalOrderCount: number;
  disclosureCount: number;
  liquidationCount: number;
  marketCount: number;
  markets: ServerMarketPublicSnapshot[];
  marginMembershipRoot: Hex;
  marginRoot: Hex;
  positionCloseCount: number;
  positionLifecycleCount: number;
  positionRoot: Hex;
  settlementCount: number;
  spentNullifierCount: number;
}

export interface ServerOwnerOrderSnapshot {
  batchId: string;
  createdAt: number;
  intentCommitment: Hex;
  isResidual: boolean;
  matchingPayloadCommitment: Hex;
  marketId: string;
  residualCommitment?: Hex;
  sourceIntentCommitment?: Hex;
  status: "open" | "filled" | "partially-filled" | "cancelled";
  updatedAt: number;
}

export interface ServerOwnerPositionSnapshot {
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
  status: "open" | "closed" | "liquidated";
  updatedAt: number;
}

export interface ServerOwnerActivitySnapshot {
  batchId?: string;
  dataCommitment?: Hex;
  id: Hex;
  kind: "account-event" | "order" | "position";
  marketId?: string;
  residualCommitment?: Hex;
  status?: ServerOwnerOrderSnapshot["status"] | ServerOwnerPositionSnapshot["status"];
  timestamp: number;
  updatedAt: number;
}

export interface ServerAccountEvent {
  createdAt: number;
  ciphertext: string;
  dataCommitment: Hex;
  eventId: Hex;
  ownerCommitment: Hex;
}

export interface ServerPortfolioSnapshot {
  accountEvents: ServerAccountEvent[];
  activities: ServerOwnerActivitySnapshot[];
  orders: ServerOwnerOrderSnapshot[];
  ownerCommitment: Hex;
  positions: ServerOwnerPositionSnapshot[];
  publicState: ServerPublicSnapshot;
}

export interface ServerIntentRecord {
  batchId: string;
  marketId: string;
  ownerCommitment: Hex;
  intentCommitment: Hex;
  matchingPayloadCommitment: Hex;
  noteNullifier: Hex;
}

export interface AccountSnapshot {
  address: string;
  accountValue: number | null;
  availableShieldedUsdc: number | null;
  cash: number | null;
  lockedMargin: number;
  livePnl: number;
  marginRoot: Hex;
  pendingShieldedUsdc: number;
  privacyMode: "shielded";
  shieldedUsdc: number | null;
}

export interface MarketDisplay {
  marketId: string;
  pair: string;
  baseAsset: string;
  quoteAsset: string;
  assetName: string;
  oraclePrice: string;
  price: number;
  change24h: number;
  openInterestLong: number;
  openInterestShort: number;
  netRateLong: number | null;
  netRateShort: number | null;
  volume24h: number;
  fundingIndex: string;
  maxLeverage: number;
  initialMarginRate: number;
  maintenanceMarginRate: number;
  status: "live" | "settling" | "paused";
}

export interface ChartCandle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface OrderDraft {
  side: Side;
  collateralAsset: "USDC";
  collateral: number;
  estimatedSize: number;
  leverage: number;
  takeProfitPrice: number | null;
  stopLossPrice: number | null;
}

export interface PositionRow {
  marketId: string;
  id: string;
  time: string;
  market: string;
  side?: Side;
  size?: number;
  collateral?: number;
  entryPrice?: number;
  marketPrice?: number;
  netValue?: number;
  closePrice: number | null;
  unrealizedPnl?: number;
  commitment?: Hex;
  privateState?: {
    entryPrice: string;
    fundingIndex: string;
    margin: string;
    positionNullifier: Hex;
    side: Side;
    size: string;
    sourceIntentCommitment: Hex;
  };
  privateDetails?: boolean;
  status?: string;
}

export interface TickerItem {
  lastPrice?: number;
  fundingRate?: number | null;
  marketId?: string;
  openInterest?: number;
  pair: string;
  change: number;
  volume24h?: number;
}

export interface TradingLiveData {
  account: AccountSnapshot;
  activity: ServerOwnerActivitySnapshot[];
  accountEventCount: number;
  markets: MarketDisplay[];
  orders: ServerOwnerOrderSnapshot[];
  positions: PositionRow[];
  ticker: TickerItem[];
}
