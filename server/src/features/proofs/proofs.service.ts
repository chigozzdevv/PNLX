import { loadCircuits, verifierEntry } from "@pnlx/proof-system";
import {
  RISC0_BATCH_MATCH_CIRCUIT_HASH,
  RISC0_BATCH_MATCH_CIRCUIT_ID,
  RISC0_BATCH_MATCH_CIRCUIT_KEY,
  RISC0_STELLAR_VERIFIER_HASH,
} from "@/workers/risc0-matcher/risc0-proof";
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
    const noirVerifiers = Array.from(loadCircuits(this.root).values()).map((circuit) => {
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
    return [
      ...noirVerifiers,
      {
        circuitHash: RISC0_BATCH_MATCH_CIRCUIT_HASH,
        circuitId: RISC0_BATCH_MATCH_CIRCUIT_ID,
        circuitKey: RISC0_BATCH_MATCH_CIRCUIT_KEY,
        verifierAuthority: `${RISC0_BATCH_MATCH_CIRCUIT_ID}-risc0-verifier`,
        verifierContract: "risc0-proof-verifier",
        verifierHash: RISC0_STELLAR_VERIFIER_HASH,
      },
    ];
  }
}
