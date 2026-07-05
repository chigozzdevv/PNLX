import type {
  AccountEncryptionKeyRecord,
  BatchSettlement,
  Hex,
  IntentRecord,
  MarketConfig,
  PositionLifecycleRecord,
  PrivateMatchIntent,
  ResidualOrderRecord,
} from "@pnlx/protocol-types";
import type { ExternalBatchSettlementTranscript } from "@/workers/executor/executor.model";
import type { ProofCoordinatorService } from "@/workers/proof-coordinator/proof-coordinator.service";

export type MatcherProvider = "risc0";

export interface MatcherConfig {
  accountEventEncryptor?: MatcherAccountEventEncryptor;
  proofs?: ProofCoordinatorService;
  provider?: MatcherProviderGateway;
}

export interface MatcherProviderGateway {
  createSettlementTranscript(
    input: MatcherSettlementInput,
    proofs: ProofCoordinatorService,
  ): MatcherProviderTranscript | Promise<MatcherProviderTranscript>;
}

export type MatcherProviderTranscript =
  | MatcherSettlementTranscript
  | ExternalBatchSettlementTranscript;

export interface MatcherSettlementInput {
  accountEncryptionKeys?: AccountEncryptionKeyRecord[];
  batchId: string;
  intents: PrivateMatchIntent[];
  market: MarketConfig;
  oldRoot: Hex;
  positionCommitments: Hex[];
  records: IntentRecord[];
  residuals?: ResidualOrderRecord[];
}

export interface MatcherSettlementTranscript {
  positionEvents: PrivatePositionOpeningEvent[];
  positionOpenings: PositionLifecycleRecord[];
  privateMatchIntents: PrivateMatchIntent[];
  residualOrders: ResidualOrderRecord[];
  settlement: BatchSettlement;
}

export type MatcherAccountEventEncryptor = (
  payload: MatcherAccountEventPayload,
) => string;

export type MatcherAccountEventPayload =
  | {
      kind: "position-opening";
      opening: PrivatePositionOpeningEvent;
    }
  | {
      kind: "residual-order";
      residual: ResidualOrderRecord;
      settlementDigest: Hex;
    };

export interface CreateExternalSettlementInput {
  batchId: string;
  includeOpenMarketOrders?: boolean;
  marketId: string;
  records?: IntentRecord[];
  residuals?: ResidualOrderRecord[];
  oldRoot?: Hex;
  positionCommitments?: Hex[];
}

export interface MatcherGateway {
  createSettlementTranscript(
    input: CreateExternalSettlementInput,
  ): ExternalBatchSettlementTranscript | Promise<ExternalBatchSettlementTranscript>;
}

export interface RemoteMatcherConfig {
  token?: string;
  url: string;
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
