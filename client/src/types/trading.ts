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
  proverJobId?: string;
  imageId?: Hex;
  journalDigest?: Hex;
  witnessHash?: Hex;
  proofHash?: Hex;
  publicInputsHash?: Hex;
  sealDigest?: Hex;
  vkHash?: Hex;
}

export interface ServerMarketFunding {
  rate?: string | null;
  status: "ready" | "warming" | "stale" | "unavailable";
  reason?: string;
  coverageMs?: number;
  requiredCoverageMs?: number;
  windowStart?: number;
  windowEnd?: number;
  settlementStatus: "running" | "paused" | "blocked";
  source: "fixed" | "impact-twap";
  intervalMs: number;
  sampleCount: number;
  minimumSamples: number;
  sampledAt: number | null;
  nextFundingAt: number | null;
}

export interface MarketOpenInterestDetails {
  status: "available" | "incomplete";
  reason?: string;
  updatedAt: number;
  convention: "half-gross-base";
}

export interface MarketFundingDisplay extends Omit<ServerMarketFunding, "rate"> {
  rate: number | null;
}

export interface MarketRiskFunding {
  status: "available" | "unavailable";
  source: "onchain-market" | "market-config";
  fundingIndex: string | null;
  updatedAt: number | null;
}

export interface ServerMarketConfig {
  riskFunding?: MarketRiskFunding;
  funding?: ServerMarketFunding;
  fundingRate?: string | null;
  marketId: string;
  openInterest?: string | null;
  openInterestDetails?: MarketOpenInterestDetails;
  oraclePrice: string;
  maxLeverage: string;
  initialMarginRate: string;
  maintenanceMarginRate: string;
  fundingIndex: string;
  volume?: string;
}

export interface ServerMarketPublicSnapshot extends ServerMarketConfig {
  aggregateVolume: string;
  conditionalCloseCount: number;
  conditionalOrderCount: number;
  grossOpenInterest?: string;
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
  cancellationTxHash?: Hex;
  createdAt: number;
  intentCommitment: Hex;
  isResidual: boolean;
  matching: {
    batchId?: string;
    capacity?: {
      limit: number;
      filledIntents: number;
      positionOutputs: number;
      marginChangeOutputs: number;
      notesToSpend: number;
      matchedExecutions?: number;
    };
    completedAt?: number;
    message: string;
    phase?: "oracle" | "maker-liquidity" | "matcher" | "proving" | "batch-settlement" | "settlement-commit" | "maker-finalize";
    reason?: string;
    runId?: Hex;
    state: "blocked" | "matching" | "proving" | "queued" | "settled" | "settling" | "waiting-liquidity";
    status?: "failed" | "running" | "settled" | "skipped";
  };
  matchingPayloadCommitment: Hex;
  marketId: string;
  noteNullifier?: Hex;
  residualCommitment?: Hex;
  sourceIntentCommitment?: Hex;
  status: "open" | "filled" | "partially-filled" | "cancelled";
  submissionTxHash?: Hex;
  updatedAt: number;
}

export interface ServerOwnerPositionSnapshot {
  batchId: string;
  proverJobId?: string;
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
  lifecycleKind?: "close" | "liquidation";
  lifecycleProofDigest?: Hex;
  lifecycleProofSystem?: ServerProofMeta["proofSystem"];
  lifecycleProofTxHash?: Hex;
  lifecycleTxHash?: Hex;
  proofSystem?: ServerProofMeta["proofSystem"];
  settlementDigest: Hex;
  settlementTxHash?: Hex;
  sourceIntentCommitment: Hex;
  status: "open" | "closed" | "liquidated";
  updatedAt: number;
}

export interface ServerOwnerActivitySnapshot {
  batchId?: string;
  proverJobId?: string;
  dataCommitment?: Hex;
  id: Hex;
  kind: "account-event" | "order" | "position" | "position-close" | "liquidation";
  marketId?: string;
  proofDigest?: Hex;
  proofSystem?: ServerProofMeta["proofSystem"];
  proofTxHash?: Hex;
  residualCommitment?: Hex;
  status?: ServerOwnerOrderSnapshot["status"] | ServerOwnerPositionSnapshot["status"];
  settlementDigest?: Hex;
  timestamp: number;
  txHash?: Hex;
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
  tradedVolume?: {
    amount: string | null;
    status: "available" | "incomplete";
    source: "pnlx-confirmed-fills";
  };
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
  tradedVolume: number | null;
}

export interface MarketDisplay {
  riskFunding?: MarketRiskFunding;
  marketId: string;
  pair: string;
  baseAsset: string;
  quoteAsset: string;
  assetName: string;
  oraclePrice: string;
  price: number;
  markPrice?: number;
  change24h: number;
  fundingRate: number | null;
  funding?: MarketFundingDisplay;
  openInterest: number | null;
  openInterestDetails?: MarketOpenInterestDetails;
  volume: number;
  fundingIndex: string;
  maxLeverage: number;
  initialMarginRate: number;
  maintenanceMarginRate: number;
  status: "live" | "settling" | "paused";
  volume24h?: number;
}

export interface MarketDayStats {
  marketId: string;
  source: "hyperliquid";
  interval: "1m";
  from: number;
  asOf: number;
  fetchedAt: number;
  change24h: number;
  high24h: number;
  low24h: number;
  open24h: number;
  lastPrice: number;
  stale: boolean;
}

export interface ChartCandle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  trades?: number;
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
  batchId: string;
  marketId: string;
  id: string;
  openedAt: number;
  time: string;
  market: string;
  side?: Side;
  size?: number;
  collateral?: number;
  entryFee?: number;
  /** Accrued funding: positive debit, negative credit. Included once in unrealizedPnl. */
  fundingPayment?: number;
  entryPrice?: number;
  marketPrice?: number;
  netValue?: number;
  closePrice: number | null;
  unrealizedPnl?: number;
  commitment?: Hex;
  proverJobId?: string;
  journalDigest?: Hex;
  proofDigest?: Hex;
  proofVerificationTxHash?: Hex;
  lifecycleKind?: "close" | "liquidation";
  lifecycleProofDigest?: Hex;
  lifecycleProofSystem?: ServerProofMeta["proofSystem"];
  lifecycleProofTxHash?: Hex;
  lifecycleTxHash?: Hex;
  proofSystem?: ServerProofMeta["proofSystem"];
  settlementDigest?: Hex;
  settlementTxHash?: Hex;
  sourceIntentCommitment: Hex;
  /** Protocol position legs represented by one aggregated UI row. */
  positionLegs?: PositionRow[];
  privateState?: {
    ownerDigest?: Hex;
    positionSeed?: Hex;
    fillIndex?: number;
    entryFee?: string;
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
