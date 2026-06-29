import { hashFields, mod } from "@merkl/crypto";
import { PRICE_SCALE, RATE_SCALE } from "@merkl/market-math";
import {
  bindProof,
  buildProofArtifact,
  loadCircuit,
  publicInputDigest,
  type ProofArtifact,
} from "@merkl/proof-system";
import type { Hex, ProofMeta } from "@merkl/protocol-types";
import type { SettlementProof, SettlementProofInput } from "@/workers/proof-coordinator/proof-coordinator.model";
import { ProofArtifactRegistry, proofKey } from "@/shared/proofs/artifact-registry";
import { join } from "node:path";
import { matchTranscriptDigest } from "@/workers/batch-matcher/match-transcript";

const MAX_BATCH_EXECUTIONS = 4;
const MAX_PUBLIC_ITEMS = MAX_BATCH_EXECUTIONS * 2;

export class ProofCoordinatorService {
  private readonly artifacts = new Map<string, ProofArtifact>();
  private readonly artifactRegistry: ProofArtifactRegistry;

  constructor(private readonly root = process.cwd()) {
    this.artifactRegistry = new ProofArtifactRegistry(join(root, ".merkl", "proof-artifacts.json"));
  }

  artifactFor(proof: ProofMeta): ProofArtifact | undefined {
    return this.artifacts.get(proofKey(proof)) ?? this.artifactRegistry.get(proof);
  }

  createSettlement(input: SettlementProofInput): SettlementProof {
    if (input.match.executions.length > MAX_BATCH_EXECUTIONS) {
      throw new Error(`batch proof supports at most ${MAX_BATCH_EXECUTIONS} executions`);
    }
    const expectedTranscriptDigest = matchTranscriptDigest(input.match);
    if (input.match.matchTranscriptDigest !== expectedTranscriptDigest) {
      throw new Error("match transcript digest mismatch");
    }
    const filledIntents = input.match.orderUpdates.map((update) => update.intentCommitment);
    const newCommitments = input.match.fills.map((fill) => fill.positionCommitment);
    assertPublicItemLimit("filled intents", filledIntents);
    assertPublicItemLimit("new commitments", newCommitments);
    assertPublicItemLimit("margin change commitments", input.match.marginChangeCommitments);
    assertPublicItemLimit("spent nullifiers", input.match.spentNullifiers);
    const executionWitnesses = input.match.executions.map((execution) => {
      const longFill = input.match.fills.find(
        (fill) =>
          fill.intentCommitment === execution.longIntentCommitment &&
          fill.side === "long" &&
          fill.size === execution.size &&
          fill.price === execution.price,
      );
      const shortFill = input.match.fills.find(
        (fill) =>
          fill.intentCommitment === execution.shortIntentCommitment &&
          fill.side === "short" &&
          fill.size === execution.size &&
          fill.price === execution.price,
      );
      if (!longFill || !shortFill) {
        throw new Error("execution is missing matching fills");
      }
      return {
        ...execution,
        longMargin: longFill.margin,
        shortMargin: shortFill.margin,
      };
    });
    const publicInputs = publicInputDigest("batch-match", [
      input.batchId,
      input.market.marketId,
      input.oldRoot,
      input.newRoot,
      input.match.matchTranscriptDigest,
      input.match.executions,
      newCommitments,
      input.match.marginChangeCommitments,
      input.match.orderUpdates,
      input.match.spentNullifiers,
      input.match.aggregateVolume,
      input.match.openInterestDelta,
      input.match.residualSize,
      input.match.totalLongSize,
      input.match.totalShortSize,
      input.market.oraclePrice,
      input.market.fundingIndex,
      input.market.initialMarginRate,
      input.market.maxLeverage,
    ]);
    const settlementDigest = field(publicInputs);
    const artifact = buildProofArtifact(this.root, "batch-match", {
      name: artifactName("batch", [input.batchId, input.market.marketId, input.newRoot]),
      inputs: {
        execution_count: BigInt(executionWitnesses.length),
        execution_prices: pad(executionWitnesses.map((execution) => execution.price)),
        execution_sizes: pad(executionWitnesses.map((execution) => execution.size)),
        initial_margin_rate: input.market.initialMarginRate,
        long_limit_prices: pad(executionWitnesses.map((execution) => execution.longLimitPrice)),
        long_intents: padExecutionFields(executionWitnesses.map((execution) => execution.longIntentCommitment)),
        long_margins: pad(executionWitnesses.map((execution) => execution.longMargin)),
        long_nullifiers: padExecutionFields(executionWitnesses.map((execution) => execution.longNoteNullifier)),
        long_position_commitments: padExecutionFields(
          executionWitnesses.map((execution) => execution.longPositionCommitment),
        ),
        maker_is_long: padBooleans(executionWitnesses.map((execution) => execution.makerSide === "long")),
        max_leverage: input.market.maxLeverage,
        price_scale: PRICE_SCALE,
        rate_scale: RATE_SCALE,
        batch_id: field(hashFields("batch-id", [input.batchId])),
        market_id: field(hashFields("market-id", [input.market.marketId])),
        old_root: field(input.oldRoot),
        new_root: field(input.newRoot),
        short_limit_prices: pad(executionWitnesses.map((execution) => execution.shortLimitPrice)),
        short_intents: padExecutionFields(executionWitnesses.map((execution) => execution.shortIntentCommitment)),
        short_margins: pad(executionWitnesses.map((execution) => execution.shortMargin)),
        short_nullifiers: padExecutionFields(executionWitnesses.map((execution) => execution.shortNoteNullifier)),
        short_position_commitments: padExecutionFields(
          executionWitnesses.map((execution) => execution.shortPositionCommitment),
        ),
        settlement_digest: settlementDigest,
        filled_intent_count: BigInt(filledIntents.length),
        filled_intents: padFields(filledIntents),
        new_commitment_count: BigInt(newCommitments.length),
        new_commitments: padFields(newCommitments),
        margin_change_count: BigInt(input.match.marginChangeCommitments.length),
        margin_change_commitments: padFields(input.match.marginChangeCommitments),
        spent_nullifier_count: BigInt(input.match.spentNullifiers.length),
        spent_nullifiers: padFields(input.match.spentNullifiers),
        total_long_size: input.match.totalLongSize,
        total_short_size: input.match.totalShortSize,
        residual_size: input.match.residualSize,
        aggregate_volume: input.match.aggregateVolume,
      },
    });

    const proof = bindProof(loadCircuit(this.root, "batch-match"), publicInputs, artifact);
    this.artifacts.set(proofKey(proof), artifact);
    this.artifactRegistry.set(proof, artifact);

    return {
      batchId: input.batchId,
      marketId: input.market.marketId,
      oldRoot: input.oldRoot,
      newRoot: input.newRoot,
      matchTranscriptDigest: input.match.matchTranscriptDigest,
      settlementDigest,
      newCommitments: input.match.fills.map((fill) => fill.positionCommitment),
      marginChangeCommitments: input.match.marginChangeCommitments,
      orderUpdates: input.match.orderUpdates,
      spentNullifiers: input.match.spentNullifiers,
      fillCount: input.match.fills.length,
      aggregateVolume: input.match.aggregateVolume,
      openInterestDelta: input.match.openInterestDelta,
      residualSize: input.match.residualSize,
      proof,
    };
  }
}

function artifactName(prefix: string, fields: unknown[]): string {
  return `${prefix}-${hashFields("proof-artifact", fields).slice(2, 18)}`;
}

function field(value: Hex): Hex {
  return `0x${mod(BigInt(value)).toString(16)}`;
}

function pad(values: bigint[]): bigint[] {
  return [...values, ...Array<bigint>(MAX_BATCH_EXECUTIONS - values.length).fill(0n)];
}

function padFields(values: Hex[]): Hex[] {
  return [
    ...values.map((value) => field(value)),
    ...Array<Hex>(MAX_PUBLIC_ITEMS - values.length).fill("0x0"),
  ];
}

function padExecutionFields(values: Hex[]): Hex[] {
  return [
    ...values.map((value) => field(value)),
    ...Array<Hex>(MAX_BATCH_EXECUTIONS - values.length).fill("0x0"),
  ];
}

function padBooleans(values: boolean[]): boolean[] {
  return [...values, ...Array<boolean>(MAX_BATCH_EXECUTIONS - values.length).fill(false)];
}

function assertPublicItemLimit(label: string, values: Hex[]): void {
  if (values.length > MAX_PUBLIC_ITEMS) {
    throw new Error(`batch proof supports at most ${MAX_PUBLIC_ITEMS} ${label}`);
  }
}
