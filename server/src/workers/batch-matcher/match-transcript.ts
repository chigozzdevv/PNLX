import { hashFields } from "@merkl/crypto";
import type { Hex } from "@merkl/protocol-types";
import type { MatchResult } from "@/workers/batch-matcher/batch-matcher.model";

export function matchTranscriptDigest(
  match: Omit<MatchResult, "matchTranscriptDigest">,
): Hex {
  return hashFields("match-transcript", [
    match.executions.map((execution) => [
      execution.longIntentCommitment,
      execution.longLimitPrice,
      execution.longNoteNullifier,
      execution.longPositionCommitment,
      execution.makerIntentCommitment,
      execution.makerSide,
      execution.price,
      execution.shortIntentCommitment,
      execution.shortLimitPrice,
      execution.shortNoteNullifier,
      execution.shortPositionCommitment,
      execution.size,
      execution.takerIntentCommitment,
    ]),
    match.fills.map((fill) => [
      fill.intentCommitment,
      fill.marketId,
      fill.ownerCommitment,
      fill.side,
      fill.size,
      fill.price,
      fill.margin,
      fill.positionCommitment,
      fill.positionNullifier,
    ]),
    match.marginChangeCommitments,
    match.orderUpdates.map((update) => [
      update.intentCommitment,
      update.residualCommitment ?? "0x0",
      update.status,
    ]),
    match.residuals.map((residual) => [
      residual.intentCommitment,
      residual.marketId,
      residual.ownerCommitment,
      residual.signedSize,
      residual.limitPrice,
      residual.margin,
      residual.noteNullifier,
      residual.sourceIntentCommitment ?? "0x0",
    ]),
    match.spentNullifiers,
    match.aggregateVolume,
    match.openInterestDelta,
    match.residualSize,
    match.totalLongSize,
    match.totalShortSize,
  ]);
}
