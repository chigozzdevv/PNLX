import type {
  ConditionalOrderCommitment,
  ConditionalOrderRecord,
  AssetWithdrawalRecord,
  BatchSettlement,
  DisclosureRecord,
  DepositNoteRecord,
  Hex,
  FundingSettlementRecord,
  IntentRecord,
  LiquidationRecord,
  MarketConfig,
  PositionCloseRecord,
  ProofMeta,
  WithdrawalRecord,
} from "@pnlx/protocol-types";
import type { RelayedTx, StellarInvokePayload } from "@/workers/relayer/relayer.model";

export interface DeploymentRegistry {
  contracts: Record<string, string>;
  network: string;
  risc0BatchMatchImageId?: Hex;
  source: string;
  sourceAddress: string;
  verifiers: Record<string, string>;
}

export interface ProofArtifactLocation {
  proofPath: string;
  publicInputsPath: string;
}

export type ProofArtifactResolver = (proof: ProofMeta) => ProofArtifactLocation | undefined;

export interface OnchainRelayConfig {
  deployment?: DeploymentRegistry;
  enabled: boolean;
  resolveProofArtifact?: ProofArtifactResolver;
}

export interface OnchainMarketConfig {
  oracleAssetAddress?: string;
  oracleAssetSymbol: string;
  oracleAssetType: "other" | "stellar";
  oracleBeamFeeToken?: string;
  oracleContractId?: string;
  oracleKind: string;
  oracleMaxAge: number;
  oracleTwapRecords: number;
  priceDecimals: number;
}

export interface OraclePublisherConfig {
  address: string;
  source?: string;
}

export interface OraclePriceRelayInput {
  assetAddress?: string;
  assetSymbol: string;
  assetType: "other" | "stellar";
  oracleContractId?: string;
  price: bigint;
  publishMode: "admin" | "committee";
  publishers: OraclePublisherConfig[];
  round: string;
  timestamp: number;
}

export interface OnchainRelayResult {
  relays: RelayedTx[];
}

export interface PreparedOnchainAction {
  command: string[];
  commandOutputDigest?: Hex;
  commandStatus?: number | null;
  contractId: string;
  functionName: string;
  kind: string;
  payload: StellarInvokePayload;
  txHash?: Hex;
  xdr?: string;
}

export interface AssetDepositRelayInput {
  amount: bigint;
  autoSign?: boolean;
  commitment: Hex;
  depositProof: DepositNoteRecord;
  from: string;
  source?: string;
  token: string;
}

export interface OnchainRelay {
  readonly enabled: boolean;
  assetBalance(token: string, account: string, source?: string): bigint;
  deposit(commitment: Hex): OnchainRelayResult;
  depositAsset(input: AssetDepositRelayInput): OnchainRelayResult;
  prepareDepositAsset(input: AssetDepositRelayInput): PreparedOnchainAction;
  tokenDigest(token: string, source?: string): Hex;
  verifyProof(proof: ProofMeta): OnchainRelayResult;
  publishOraclePrice(input: OraclePriceRelayInput): OnchainRelayResult;
  publishOraclePriceAsync?(input: OraclePriceRelayInput): Promise<OnchainRelayResult>;
  positionRoot?(): Hex;
  positionRootAsync?(): Promise<Hex>;
  isBatchSettled?(batchId: string, marketId: string): boolean;
  isBatchSettledAsync?(batchId: string, marketId: string): Promise<boolean>;
  isIntentRegistered?(intentCommitment: Hex): boolean;
  isIntentRegisteredAsync?(intentCommitment: Hex): Promise<boolean>;
  isMarketActive?(marketId: string): boolean;
  isMarketActiveAsync?(marketId: string): Promise<boolean>;
  submitIntent(record: IntentRecord): OnchainRelayResult;
  submitIntentAsync?(record: IntentRecord): Promise<OnchainRelayResult>;
  cancelIntent(intentCommitment: Hex): OnchainRelayResult;
  upsertMarket(record: MarketConfig, config: OnchainMarketConfig): OnchainRelayResult;
  upsertMarketAsync?(record: MarketConfig, config: OnchainMarketConfig): Promise<OnchainRelayResult>;
  settleBatch(record: BatchSettlement): OnchainRelayResult;
  settleBatchAsync?(record: BatchSettlement): Promise<OnchainRelayResult>;
  registerConditionalOrder(record: ConditionalOrderCommitment): OnchainRelayResult;
  triggerConditionalClose(record: ConditionalOrderRecord): OnchainRelayResult;
  settlePositionClose(record: PositionCloseRecord): OnchainRelayResult;
  settleManualPositionClose(record: PositionCloseRecord): OnchainRelayResult;
  withdraw(record: WithdrawalRecord): OnchainRelayResult;
  withdrawAsset(record: AssetWithdrawalRecord): OnchainRelayResult;
  liquidate(record: LiquidationRecord): OnchainRelayResult;
  disclose(record: DisclosureRecord): OnchainRelayResult;
  settleFunding(record: FundingSettlementRecord): OnchainRelayResult;
}
