import type { Hex, IntentRecord, ResidualOrderRecord } from "@merkl/protocol-types";
import type { ExternalBatchSettlementTranscript } from "@/workers/executor/executor.model";
import type {
  CommitteeSettlementInput,
  CommitteeSettlementTranscript,
  PrivatePositionOpeningEvent,
} from "@/workers/threshold-shares/threshold-shares.model";
import type { ProofCoordinatorService } from "@/workers/proof-coordinator/proof-coordinator.service";

export type MatcherComputeBackend = "local-threshold" | "remote-blind" | "nilcc";

export interface MatcherSigner {
  address: string;
  sign(message: string): string;
}

export interface MatcherConfig {
  accountEventEncryptor?: MatcherAccountEventEncryptor;
  compute?: BlindComputeGateway;
  signers?: MatcherSigner[];
}

export interface BlindComputeGateway {
  createSettlementTranscript(
    input: CommitteeSettlementInput,
    proofs: ProofCoordinatorService,
  ): CommitteeSettlementTranscript | Promise<CommitteeSettlementTranscript>;
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

export interface RemoteBlindComputeConfig {
  token?: string;
  url: string;
}

export interface NilccBlindComputeConfig {
  attestationContains: string[];
  attestationReportSha256?: string;
  attestationReportUrl?: string;
  attestationRequired: boolean;
  attestationToken?: string;
  token?: string;
  workloadUrl: string;
}
