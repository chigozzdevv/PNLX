import type { CommitteeSettlementTranscript } from "@/workers/threshold-shares/threshold-shares.model";
import { ThresholdShareCommittee } from "@/workers/threshold-shares/threshold-shares.service";
import { ProofCoordinatorService } from "@/workers/proof-coordinator/proof-coordinator.service";
import type { MatcherProviderConfig, MatcherProviderSettlementRequest } from "@/workers/matcher-provider/matcher-provider.model";

export class MatcherProviderService {
  private readonly committee: ThresholdShareCommittee;
  private readonly proofs = new ProofCoordinatorService();

  constructor(config: MatcherProviderConfig) {
    this.committee = new ThresholdShareCommittee({
      nodeIds: config.thresholdShareNodeIds,
      shareStoreDir: config.thresholdShareStoreDir,
      threshold: config.thresholdShareThreshold,
    });
  }

  createSettlementTranscript(input: MatcherProviderSettlementRequest): CommitteeSettlementTranscript {
    return this.committee.createSettlementTranscript(input, this.proofs);
  }
}
