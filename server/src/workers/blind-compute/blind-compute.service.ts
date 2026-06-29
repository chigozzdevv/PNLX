import type { CommitteeSettlementTranscript } from "../threshold-shares/threshold-shares.model";
import { ThresholdShareCommittee } from "../threshold-shares/threshold-shares.service";
import { ProofCoordinatorService } from "../proof-coordinator/proof-coordinator.service";
import type { BlindComputeConfig, BlindComputeSettlementRequest } from "./blind-compute.model";

export class BlindComputeService {
  private readonly committee: ThresholdShareCommittee;
  private readonly proofs = new ProofCoordinatorService();

  constructor(config: BlindComputeConfig) {
    this.committee = new ThresholdShareCommittee({
      nodeIds: config.thresholdShareNodeIds,
      shareStoreDir: config.thresholdShareStoreDir,
      threshold: config.thresholdShareThreshold,
    });
  }

  createSettlementTranscript(input: BlindComputeSettlementRequest): CommitteeSettlementTranscript {
    return this.committee.createSettlementTranscript(input, this.proofs);
  }
}
