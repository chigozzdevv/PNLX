import type { ProofArtifact } from "@pnlx/proof-system";
import type { ProofMeta } from "@pnlx/protocol-types";
import type { SettlementProof, SettlementProofInput } from "@/workers/proof-coordinator/proof-coordinator.model";
import { ProofArtifactRegistry, proofKey } from "@/shared/proofs/artifact-registry";
import { join } from "node:path";
import { createRisc0BatchSettlement } from "@/workers/risc0-matcher/risc0-proof";

export class ProofCoordinatorService {
  private readonly artifacts = new Map<string, ProofArtifact>();
  private readonly artifactRegistry: ProofArtifactRegistry;

  constructor(private readonly root = process.cwd()) {
    this.artifactRegistry = new ProofArtifactRegistry(join(root, ".pnlx", "proof-artifacts.json"));
  }

  artifactFor(proof: ProofMeta): ProofArtifact | undefined {
    return this.artifacts.get(proofKey(proof)) ?? this.artifactRegistry.get(proof);
  }

  createSettlement(input: SettlementProofInput): SettlementProof {
    const { artifact, settlement } = createRisc0BatchSettlement(input, this.root);
    this.artifacts.set(proofKey(settlement.proof), artifact);
    this.artifactRegistry.set(settlement.proof, artifact);
    return settlement;
  }
}
