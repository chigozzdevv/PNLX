export type Hex = `0x${string}`;

export interface ProofMeta {
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

export type Side = "long" | "short";

export interface MarginNote {
  assetId: string;
  amount: bigint;
  owner: string;
  rho: string;
  blinding: string;
}

export interface PositionNote {
  marketId: string;
  side: Side;
  size: bigint;
  entryPrice: bigint;
  margin: bigint;
  fundingIndex: bigint;
  owner: string;
  rho: string;
  blinding: string;
}

export interface TradeIntent {
  batchId: string;
  marketId: string;
  owner: string;
  side: Side;
  size: bigint;
  limitPrice: bigint;
  margin: bigint;
  noteNullifier: Hex;
  nonce: string;
  salt: string;
}

export interface PrivateMatchIntent {
  batchId: string;
  intentCommitment: Hex;
  limitPrice: bigint;
  margin: bigint;
  marketId: string;
  noteChangeCommitment: Hex;
  noteNullifier: Hex;
  ownerCommitment: Hex;
  signedSize: bigint;
  sourceIntentCommitment?: Hex;
}

export interface IntentRecord {
  batchId: string;
  batchDigest: Hex;
  marketId: string;
  marketDigest: Hex;
  marginRoot: Hex;
  ownerCommitmentField: Hex;
  ownerCommitment: Hex;
  intentCommitment: Hex;
  matchingPayloadCommitment: Hex;
  noteChangeCommitment: Hex;
  proof: ProofMeta;
  noteNullifier: Hex;
}

export type OrderStatus = "open" | "partially-filled" | "filled" | "cancelled";

export interface OrderLifecycleUpdate {
  intentCommitment: Hex;
  residualCommitment?: Hex;
  status: OrderStatus;
}

export interface OrderLifecycleRecord extends OrderLifecycleUpdate {
  batchId: string;
  createdAt: number;
  marketId: string;
  ownerCommitment: Hex;
  updatedAt: number;
}

export interface ResidualOrderRecord {
  batchId: string;
  createdAt: number;
  intentCommitment: Hex;
  marketId: string;
  matchingPayloadCommitment: Hex;
  noteNullifier: Hex;
  ownerCommitment: Hex;
  sourceIntentCommitment: Hex;
  updatedAt: number;
}

export type PositionStatus = "open" | "closed" | "liquidated";

export interface PositionLifecycleRecord {
  batchId: string;
  closeCommitment?: Hex;
  liquidationRewardCommitment?: Hex;
  marginOutputCommitment?: Hex;
  marketId: string;
  newPositionCommitment?: Hex;
  openedAt: number;
  ownerCommitment: Hex;
  positionCommitment: Hex;
  positionNullifier: Hex;
  settlementDigest: Hex;
  sourceIntentCommitment: Hex;
  status: PositionStatus;
  updatedAt: number;
}

export interface IntentValidityWitness {
  assetDigest: Hex;
  blinding: Hex;
  changeBlinding: Hex;
  changeRhoDigest: Hex;
  currentBatch: bigint;
  expiryBatch: bigint;
  intent: TradeIntent;
  marginRoot: Hex;
  noteAmount: bigint;
  noteChangeCommitment: Hex;
  noteCommitment: Hex;
  ownerDigest: Hex;
  pathIndices: boolean[];
  pathSiblings: Hex[];
  rhoDigest: Hex;
  spendSecretDigest: Hex;
}

export interface IntentValidityRecord {
  batchDigest: Hex;
  currentBatch: bigint;
  expiryBatch: bigint;
  intentCommitment: Hex;
  marketDigest: Hex;
  noteChangeCommitment: Hex;
  noteCommitment: Hex;
  marginRoot: Hex;
  noteNullifier: Hex;
  ownerCommitmentField: Hex;
  proof: ProofMeta;
}

export interface DepositNoteWitness {
  amount: bigint;
  blinding: Hex;
  commitment: Hex;
  ownerDigest: Hex;
  rhoDigest: Hex;
  tokenDigest: Hex;
}

export interface DepositNoteRecord {
  amount: bigint;
  commitment: Hex;
  tokenDigest: Hex;
  proof: ProofMeta;
}

export interface PendingAssetDepositRecord {
  amount: bigint;
  commitment: Hex;
  createdAt: number;
  depositProof: DepositNoteRecord;
  finalizedAt?: number;
  from: string;
  preparedTxHash?: Hex;
  preparedXdrDigest: Hex;
  relayId?: Hex;
  token: string;
  tokenDigest: Hex;
  txHash?: Hex;
}

export interface MarketConfig {
  marketId: string;
  oraclePrice: bigint;
  maxLeverage: bigint;
  initialMarginRate: bigint;
  maintenanceMarginRate: bigint;
  fundingIndex: bigint;
}

export interface FundingUpdateRecord {
  appliedAt: number;
  fundingDelta: bigint;
  marketId: string;
  newFundingIndex: bigint;
  oldFundingIndex: bigint;
  premiumRate?: bigint;
  premiumSampleCount?: number;
  premiumSource?: "fixed" | "impact-twap";
}

export interface FundingPremiumSampleRecord {
  impactAskPrice?: bigint;
  impactBidPrice?: bigint;
  impactNotional: bigint;
  indexPrice: bigint;
  marketId: string;
  premiumRate: bigint;
  sampledAt: number;
  source: "impact-orderbook";
}

export interface FundingSettlementRecord extends FundingUpdateRecord {
  elapsedMs: number;
  intervalMs: number;
  markPrice: bigint;
  maxFundingDelta?: bigint;
  premiumRate: bigint;
  proof: ProofMeta;
}

export type BatchExecutionRunStatus = "failed" | "settled" | "skipped";
export type BatchExecutionPhase =
  | "oracle"
  | "maker-liquidity"
  | "matcher"
  | "batch-settlement"
  | "settlement-commit"
  | "maker-finalize";

export interface BatchExecutionRunRecord {
  aggregateVolume?: bigint;
  batchId: string;
  completedAt: number;
  fillCount?: number;
  marketId: string;
  phase?: BatchExecutionPhase;
  reason?: string;
  runId: Hex;
  settlementDigest?: Hex;
  startedAt: number;
  status: BatchExecutionRunStatus;
}

export type LiquidationAutomationJobStatus = "pending" | "executed" | "failed" | "stale";

export interface LiquidationAutomationJobRecord {
  createdAt: number;
  executedAt?: number;
  failedAt?: number;
  jobId: Hex;
  liquidation: LiquidationRecord;
  marketId: string;
  positionCommitment: Hex;
  positionNullifier: Hex;
  reason?: string;
  rewardCommitment: Hex;
  status: LiquidationAutomationJobStatus;
  updatedAt: number;
}

export interface Fill {
  intentCommitment: Hex;
  marketId: string;
  ownerCommitment: Hex;
  side: Side;
  size: bigint;
  price: bigint;
  margin: bigint;
  positionCommitment: Hex;
  positionNullifier: Hex;
}

export interface BatchSettlement {
  batchId: string;
  marketId: string;
  oldRoot: Hex;
  newRoot: Hex;
  matchTranscriptDigest: Hex;
  settlementDigest: Hex;
  newCommitments: Hex[];
  marginChangeCommitments: Hex[];
  spentNullifiers: Hex[];
  fillCount: number;
  aggregateVolume: bigint;
  openInterestDelta: bigint;
  orderUpdates: OrderLifecycleUpdate[];
  residualSize: bigint;
  proof: ProofMeta;
}

export interface LiquidationWitness {
  marketId: string;
  positionCommitment: Hex;
  positionNullifier: Hex;
  positionRoot: Hex;
  rewardCommitment: Hex;
  side: Side;
  size: bigint;
  entryPrice: bigint;
  markPrice: bigint;
  margin: bigint;
  fundingPayment: bigint;
  fundingIndex: bigint;
  maintenanceRate: bigint;
  marketDigest: Hex;
  ownerDigest: Hex;
  rhoDigest: Hex;
  blinding: Hex;
  spendSecretDigest: Hex;
  pathIndices: boolean[];
  pathSiblings: Hex[];
}

export interface LiquidationRecord {
  marketId: string;
  markPrice: bigint;
  maintenanceRate: bigint;
  positionCommitment: Hex;
  positionNullifier: Hex;
  positionRoot: Hex;
  rewardCommitment: Hex;
  proof: ProofMeta;
}

export type ConditionalOrderKind = "take-profit" | "stop-loss";

export interface ConditionalOrderWitness {
  marketId: string;
  positionNullifier: Hex;
  side: Side;
  kind: ConditionalOrderKind;
  triggerPrice: bigint;
  markPrice: bigint;
  size: bigint;
  reduceOnly: boolean;
  salt: string;
}

export interface ConditionalOrderCommitment {
  marketId: string;
  positionNullifier: Hex;
  closeCommitment: Hex;
}

export interface ConditionalOrderRecord {
  marketId: string;
  markPrice: bigint;
  positionNullifier: Hex;
  closeCommitment: Hex;
  proof: ProofMeta;
}

export interface PositionCloseWitness {
  marketId: string;
  positionCommitment: Hex;
  positionNullifier: Hex;
  positionRoot: Hex;
  closeCommitment: Hex;
  side: Side;
  size: bigint;
  closeSize: bigint;
  entryPrice: bigint;
  markPrice: bigint;
  margin: bigint;
  fundingIndex: bigint;
  fundingPayment: bigint;
  fee: bigint;
  newMargin: bigint;
  remainingMargin: bigint;
  marginOutputAmount: bigint;
  newPositionCommitment: Hex;
  newPositionRoot: Hex;
  marginOutputCommitment: Hex;
  marketDigest: Hex;
  ownerDigest: Hex;
  rhoDigest: Hex;
  blinding: Hex;
  spendSecretDigest: Hex;
  newPositionRhoDigest: Hex;
  newPositionBlinding: Hex;
  marginOutputAssetDigest: Hex;
  marginOutputRhoDigest: Hex;
  marginOutputBlinding: Hex;
  pathIndices: boolean[];
  pathSiblings: Hex[];
}

export interface PositionCloseRecord {
  marketId: string;
  markPrice: bigint;
  positionCommitment: Hex;
  positionNullifier: Hex;
  positionRoot: Hex;
  closeCommitment: Hex;
  newPositionCommitment: Hex;
  newPositionRoot: Hex;
  marginOutputCommitment: Hex;
  proof: ProofMeta;
}

export interface DisclosureInput {
  subject: Hex;
  claim: string;
  root: Hex;
  salt: string;
  saltDigest: Hex;
  value: bigint;
  threshold: bigint;
  pathIndices: boolean[];
  pathSiblings: Hex[];
}

export interface DisclosureRecord {
  disclosureId: Hex;
  subject: Hex;
  claimDigest: Hex;
  root: Hex;
  threshold: bigint;
  proof: ProofMeta;
}

export interface WithdrawalRequest {
  assetDigest: Hex;
  blinding: Hex;
  changeBlinding?: Hex;
  changeRhoDigest?: Hex;
  noteAmount: bigint;
  noteCommitment: Hex;
  withdrawAmount: bigint;
  ownerDigest: Hex;
  pathIndices: boolean[];
  pathSiblings: Hex[];
  root: Hex;
  rhoDigest: Hex;
  nullifier: Hex;
  recipient: Hex;
  spendSecretDigest: Hex;
  tokenDigest?: Hex;
}

export interface WithdrawalRecord {
  root: Hex;
  nullifier: Hex;
  recipient: Hex;
  tokenDigest: Hex;
  withdrawAmount: bigint;
  changeCommitment: Hex;
  proof: ProofMeta;
}

export interface AssetWithdrawalRequest extends WithdrawalRequest {
  recipientAddress: string;
  recipientDigest: Hex;
  token: string;
  tokenDigest: Hex;
}

export interface AssetWithdrawalRecord extends WithdrawalRecord {
  recipientAddress: string;
  token: string;
}

export interface AccountEventRecord {
  ciphertext: string;
  createdAt: number;
  dataCommitment: Hex;
  eventId: Hex;
  ownerCommitment: Hex;
}

export interface AccountEncryptionKeyRecord {
  algorithm: "ecdh-p256-aes-gcm";
  createdAt: number;
  ownerCommitment: Hex;
  publicKey: string;
  updatedAt: number;
}
