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
  PairedPositionCloseRecord,
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
  signal?: AbortSignal;
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
  marketPriceAsync?(marketId: string): Promise<bigint>;
  marketPriceSnapshotAsync?(marketId: string): Promise<{price:bigint;timestamp:number}>;
  marketFundingIndexAsync?(marketId: string): Promise<bigint>;
  isConditionalTriggeredAsync?(marketId: string, positionNullifier: Hex, closeCommitment: Hex): Promise<boolean>;
  isPositionCloseSettledAsync?(closeCommitment: Hex): Promise<boolean>;
  positionCloseAppendIndexAsync?(closeCommitment: Hex): Promise<number>;
  secureNoteSnapshot?(cached?: Hex[]): { commitments: Hex[]; root: Hex };
  isSecureNoteRootKnownAsync?(root: Hex): Promise<boolean>;
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
  batchPositionAppendIndexAsync?(batchId: string, marketId: string): Promise<number>;
  isBatchSettled?(batchId: string, marketId: string, settlementDigest?: Hex): boolean;
  isBatchSettledAsync?(batchId: string, marketId: string, settlementDigest?: Hex): Promise<boolean>;
  isIntentRegistered?(intentCommitment: Hex): boolean;
  isIntentRegisteredAsync?(intentCommitment: Hex): Promise<boolean>;
  intentMatchingPayloadCommitmentAsync?(intentCommitment:Hex):Promise<Hex>;
  isIntentActiveAsync?(intentCommitment:Hex):Promise<boolean>;
  isIntentCancelledAsync?(intentCommitment: Hex): Promise<boolean>;
  isSecureNullifierSpentAsync?(noteNullifier:Hex):Promise<boolean>;
  intentSubmissionSequence?(intentCommitment: Hex): bigint;
  intentSubmissionSequenceAsync?(intentCommitment: Hex): Promise<bigint>;
  isMarketActive?(marketId: string): boolean;
  isMarketActiveAsync?(marketId: string): Promise<boolean>;
  submitIntent(record: IntentRecord): OnchainRelayResult;
  submitIntentAsync?(record: IntentRecord): Promise<OnchainRelayResult>;
  cancelIntent(intentCommitment: Hex): OnchainRelayResult;
  residualMargin(intentCommitment: Hex): bigint;
  claimedResidual(intentCommitment: Hex): Hex | undefined;
  claimResidual(intentCommitment: Hex, commitment: Hex, proof: ProofMeta): OnchainRelayResult;
  upsertMarket(record: MarketConfig, config: OnchainMarketConfig): OnchainRelayResult;
  upsertMarketAsync?(record: MarketConfig, config: OnchainMarketConfig, signal?: AbortSignal): Promise<OnchainRelayResult>;
  settleBatch(record: BatchSettlement): OnchainRelayResult;
  settleBatchAsync?(record: BatchSettlement): Promise<OnchainRelayResult>;
  registerConditionalOrder(record: ConditionalOrderCommitment): OnchainRelayResult;
  registerConditionalOrderAsync?(record: ConditionalOrderCommitment): Promise<OnchainRelayResult>;
  triggerConditionalClose(record: ConditionalOrderRecord): OnchainRelayResult;
  triggerConditionalCloseAsync?(record: ConditionalOrderRecord): Promise<OnchainRelayResult>;
  settlePositionClose(record: PositionCloseRecord): OnchainRelayResult;
  settleManualPositionClose(record: PositionCloseRecord): OnchainRelayResult;
  settlePairedPositionClose(
    trader: PositionCloseRecord,
    maker: PositionCloseRecord,
    conditional: boolean,
  ): OnchainRelayResult;
  settleProvenPositionPair?(pair: PairedPositionCloseRecord, conditional: boolean): OnchainRelayResult;
  withdraw(record: WithdrawalRecord): OnchainRelayResult;
  withdrawAsset(record: AssetWithdrawalRecord): OnchainRelayResult;
  liquidate(record: LiquidationRecord): OnchainRelayResult;
  disclose(record: DisclosureRecord): OnchainRelayResult;
  settleFunding(record: FundingSettlementRecord): OnchainRelayResult;
  settleFundingAsync?(record: FundingSettlementRecord,
    beforeSubmit: (prepared: {txHash:Hex;xdr:string}) => Promise<void>,
    prepared?: {txHash:Hex;xdr:string}): Promise<OnchainRelayResult>;
  isFundingSettledAsync?(marketId: string, oldIndex: bigint, newIndex: bigint, cycleId?: Hex): Promise<boolean>;
  fundingTransactionStatusAsync?(txHash: Hex): Promise<"SUCCESS"|"FAILED"|"NOT_FOUND">;
  fundingActivationReadyAsync?(): Promise<boolean>;
}
