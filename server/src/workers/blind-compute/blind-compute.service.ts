import type { CommitteeSettlementTranscript } from "../mpc-node/mpc-node.model";
import { MpcCommittee } from "../mpc-node/mpc-node.service";
import { ProofCoordinatorService } from "../proof-coordinator/proof-coordinator.service";
import type { BlindComputeConfig, BlindComputeSettlementRequest } from "./blind-compute.model";

export class BlindComputeService {
  private readonly committee: MpcCommittee;
  private readonly proofs = new ProofCoordinatorService();

  constructor(config: BlindComputeConfig) {
    this.committee = new MpcCommittee({
      nodeIds: config.mpcNodeIds,
      shareStoreDir: config.mpcShareStoreDir,
      threshold: config.mpcThreshold,
    });
  }

  createSettlementTranscript(input: BlindComputeSettlementRequest): CommitteeSettlementTranscript {
    return this.committee.createSettlementTranscript(input, this.proofs);
  }
}
