import type { Hex, IntentRecord, ResidualOrderRecord } from "@pnlx/protocol-types";
import type { ExternalBatchSettlementTranscript } from "@/workers/executor/executor.model";
import type {
  CommitteeSettlementInput,
  CommitteeSettlementTranscript,
  PrivatePositionOpeningEvent,
} from "@/workers/threshold-shares/threshold-shares.model";
import type { ProofCoordinatorService } from "@/workers/proof-coordinator/proof-coordinator.service";

export type MatcherProvider = "risc0";

export interface MatcherConfig {
  accountEventEncryptor?: MatcherAccountEventEncryptor;
  provider?: MatcherProviderGateway;
}

export interface MatcherProviderGateway {
  createSettlementTranscript(
    input: CommitteeSettlementInput,
    proofs: ProofCoordinatorService,
  ): MatcherProviderTranscript | Promise<MatcherProviderTranscript>;
}

export type MatcherProviderTranscript =
  | CommitteeSettlementTranscript
  | ExternalBatchSettlementTranscript;

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
