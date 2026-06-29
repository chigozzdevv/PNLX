import { hashFields } from "@merkl/crypto";
import type { Hex } from "@merkl/protocol-types";
import type { ExternalBatchSettlementTranscript } from "@/workers/executor/executor.model";
import { batchSettlementPublicInputHash } from "@/shared/protocol/batch-settlement-proof";

export function externalMatcherTranscriptHash(
  transcript: Pick<ExternalBatchSettlementTranscript, "accountEvents" | "positionOpenings" | "residualOrders" | "settlement">,
): Hex {
  const { settlement } = transcript;
  return hashFields("external-matcher-transcript", [
    batchSettlementPublicInputHash(settlement),
    settlement.matchTranscriptDigest,
    settlement.proof.proofDigest,
    transcript.positionOpenings.map((opening) => [
      opening.batchId,
      opening.marketId,
      opening.ownerCommitment,
      opening.positionCommitment,
      opening.positionNullifier,
      opening.settlementDigest,
      opening.sourceIntentCommitment,
      opening.status,
      opening.closeCommitment ?? "0x0",
      opening.openedAt,
      opening.liquidationRewardCommitment ?? "0x0",
      opening.marginOutputCommitment ?? "0x0",
      opening.newPositionCommitment ?? "0x0",
      opening.updatedAt,
    ]),
    (transcript.residualOrders ?? []).map((residual) => [
      residual.batchId,
      residual.intentCommitment,
      residual.marketId,
      residual.noteNullifier,
      residual.ownerCommitment,
      residual.shareCommitment,
      residual.sourceIntentCommitment,
      residual.createdAt,
      residual.updatedAt,
    ]),
    transcript.accountEvents.map((event) => [
      event.eventId,
      event.ownerCommitment,
      event.dataCommitment,
      event.ciphertext,
      event.createdAt,
    ]),
  ]);
}
