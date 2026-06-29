import { loadCircuits, verifierEntry } from "@merkl/proof-system";
import type { ProverService } from "@/workers/prover/prover.service";
import type {
  DisclosureProofRequest,
  DisclosureProofResult,
  IntentValidityProofRequest,
  IntentValidityProofResult,
  LiquidationProofRequest,
  LiquidationProofResult,
  ProofArtifactRegistrationInput,
  VerifierRegistryItem,
} from "@/features/proofs/proofs.model";

export class ProofsService {
  constructor(
    private readonly prover: ProverService,
    private readonly root = process.cwd(),
  ) {}

  liquidation(input: LiquidationProofRequest): LiquidationProofResult {
    return this.prover.proveLiquidation(input);
  }

  intent(input: IntentValidityProofRequest): IntentValidityProofResult {
    return this.prover.proveIntentValidity(input);
  }

  disclosure(input: DisclosureProofRequest): DisclosureProofResult {
    return this.prover.proveDisclosure(input);
  }

  registerArtifact(input: ProofArtifactRegistrationInput) {
    return this.prover.registerProofArtifact(input);
  }

  verifiers(): VerifierRegistryItem[] {
    return Array.from(loadCircuits(this.root).values()).map((circuit) => {
      const entry = verifierEntry(circuit);

      return {
        circuitId: circuit.id,
        circuitKey: entry.circuitId,
        circuitHash: circuit.sourceHash,
        verifierHash: entry.verifierHash,
        verifierAuthority: `${circuit.id}-proof-verifier`,
        verifierContract: "proof-verifier",
      };
    });
  }
}
