import type { ProofArtifact } from "@pnlx/proof-system";
import type { ProofMeta } from "@pnlx/protocol-types";
import type { SettlementProof, SettlementProofInput } from "@/workers/proof-coordinator/proof-coordinator.model";
import { ProofArtifactRegistry, proofKey } from "@/shared/proofs/artifact-registry";
import { join } from "node:path";
import { hashFields } from "@pnlx/crypto";
import {
  RISC0_BATCH_MATCH_CIRCUIT_HASH,
  RISC0_BATCH_MATCH_CIRCUIT_ID,
  RISC0_BATCH_MATCH_CIRCUIT_KEY,
  RISC0_STELLAR_VERIFIER_HASH,
  createRisc0BatchSettlement,
} from "@/workers/risc0-matcher/risc0-proof";
import { batchSettlementPublicInputHash } from "@/shared/protocol/batch-settlement-proof";
import { FEE_CONFIG_HASH } from "@/shared/protocol/fee-config";
import { matchTranscriptDigest } from "@/workers/batch-matcher/match-transcript";
import { matchingPayloadCommitment } from "@/workers/batch-matcher/private-intent";

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
    if (process.env.NODE_ENV === "test" && process.env.RISC0_REAL_PROVER !== "true") {
      if (input.match.matchTranscriptDigest !== matchTranscriptDigest(input.match)) {
        throw new Error("match transcript digest mismatch");
      }
      return this.createOfflineTestSettlement(input);
    }
    throw new Error("production settlement proofs must use createSettlementAsync");
  }

  async createSettlementAsync(input: SettlementProofInput): Promise<SettlementProof> {
    if (process.env.NODE_ENV === "test" && process.env.RISC0_REAL_PROVER !== "true") {
      return this.createSettlement(input);
    }
    const { artifact, settlement } = await createRisc0BatchSettlement(input, this.root);
    this.artifacts.set(proofKey(settlement.proof), artifact);
    this.artifactRegistry.set(settlement.proof, artifact);
    return settlement;
  }

  private createOfflineTestSettlement(input: SettlementProofInput): SettlementProof {
    const newCommitments = input.match.fills.map((fill) => fill.positionCommitment);
    const privateByIntent = new Map(input.intents.map((intent) => [intent.intentCommitment, intent]));
    const residualBySource = new Map(input.match.residuals.map((intent) => [intent.sourceIntentCommitment, intent]));
    const draft = {
      aggregateVolume: input.match.aggregateVolume,
      batchId: input.batchId,
      fillCount: input.match.fills.length,
      feeConfigHash: FEE_CONFIG_HASH,
      grossTakerFee: input.match.fees.grossTakerFee,
      makerRebate: input.match.fees.makerRebate,
      insuranceFee: input.match.fees.insurance,
      treasuryFee: input.match.fees.treasury,
      makerIntents: input.match.executions.map((execution) => execution.makerIntentCommitment),
      takerIntents: input.match.executions.map((execution) => execution.takerIntentCommitment),
      marginChangeCommitments: input.match.marginChangeCommitments,
      matchingPayloadCommitments: input.match.orderUpdates.map((update) => {
        const intent = privateByIntent.get(update.intentCommitment);
        if (!intent) throw new Error("filled intent private payload is missing");
        return matchingPayloadCommitment(intent);
      }),
      residualCommitments: input.match.orderUpdates.map((update) => update.residualCommitment ?? "0x0" as const),
      residualMargins: input.match.orderUpdates.map((update) => residualBySource.get(update.intentCommitment)?.margin ?? 0n),
      residualPayloadCommitments: input.match.orderUpdates.map((update) => {
        const residual = residualBySource.get(update.intentCommitment);
        return residual ? matchingPayloadCommitment(residual) : "0x0" as const;
      }),
      marketId: input.market.marketId,
      matchTranscriptDigest: input.match.matchTranscriptDigest,
      newCommitments,
      openInterestDelta: input.match.openInterestDelta,
      orderUpdates: input.match.orderUpdates,
      residualSize: input.match.residualSize,
      settlementDigest: hashFields("test-risc0-settlement", [
        input.batchId,
        input.market.marketId,
        input.match.matchTranscriptDigest,
      ]),
      spentNullifiers: input.match.spentNullifiers,
    };
    const publicInputHash = batchSettlementPublicInputHash({
      ...draft,
      proof: {
        circuitHash: RISC0_BATCH_MATCH_CIRCUIT_HASH,
        circuitId: RISC0_BATCH_MATCH_CIRCUIT_ID,
        circuitKey: RISC0_BATCH_MATCH_CIRCUIT_KEY,
        proofDigest: "0x0",
        proofSystem: "risc0-groth16",
        publicInputHash: "0x0",
        verifierHash: RISC0_STELLAR_VERIFIER_HASH,
      },
    });
    const sealDigest = hashFields("test-risc0-seal", [input.batchId, publicInputHash]);
    return {
      ...draft,
      proof: {
        circuitHash: RISC0_BATCH_MATCH_CIRCUIT_HASH,
        circuitId: RISC0_BATCH_MATCH_CIRCUIT_ID,
        circuitKey: RISC0_BATCH_MATCH_CIRCUIT_KEY,
        imageId: hashFields("test-risc0-image", [input.batchId, input.market.marketId]),
        journalDigest: publicInputHash,
        proofDigest: sealDigest,
        proofSystem: "risc0-groth16",
        publicInputHash,
        sealDigest,
        verifierHash: RISC0_STELLAR_VERIFIER_HASH,
      },
    };
  }
}
