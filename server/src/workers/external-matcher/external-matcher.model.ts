import type { Hex, IntentRecord, ResidualOrderRecord } from "@merkl/protocol-types";
import type { ExternalBatchSettlementTranscript } from "../executor/executor.model";
import type {
  CommitteeSettlementInput,
  CommitteeSettlementTranscript,
  PrivatePositionOpeningEvent,
} from "../threshold-shares/threshold-shares.model";
import type { ProofCoordinatorService } from "../proof-coordinator/proof-coordinator.service";

export type MatcherComputeBackend = "local-threshold" | "remote-blind" | "nilcc";

export interface ExternalMatcherSigner {
  address: string;
  sign(message: string): string;
}

export interface ExternalMatcherConfig {
  accountEventEncryptor?: ExternalMatcherAccountEventEncryptor;
  compute?: BlindComputeGateway;
  signers?: ExternalMatcherSigner[];
}

export interface BlindComputeGateway {
  createSettlementTranscript(
    input: CommitteeSettlementInput,
    proofs: ProofCoordinatorService,
  ): CommitteeSettlementTranscript | Promise<CommitteeSettlementTranscript>;
}

export type ExternalMatcherAccountEventEncryptor = (
  payload: ExternalMatcherAccountEventPayload,
) => string;

export type ExternalMatcherAccountEventPayload =
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

export interface ExternalMatcherGateway {
  createSettlementTranscript(
    input: CreateExternalSettlementInput,
  ): ExternalBatchSettlementTranscript | Promise<ExternalBatchSettlementTranscript>;
}

export interface RemoteExternalMatcherConfig {
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
