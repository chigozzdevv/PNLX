import type { Fill, Hex, MarketConfig, OrderLifecycleUpdate } from "@merkl/protocol-types";
import type { RecoveredIntent } from "../threshold-shares/threshold-shares.model";

export interface MatchInput {
  batchId: string;
  market: MarketConfig;
  intents: RecoveredIntent[];
}

export interface MatchResult {
  executions: MatchExecution[];
  fills: Fill[];
  matchTranscriptDigest: Hex;
  marginChangeCommitments: Hex[];
  orderUpdates: OrderLifecycleUpdate[];
  residuals: RecoveredIntent[];
  spentNullifiers: Hex[];
  aggregateVolume: bigint;
  openInterestDelta: bigint;
  residualSize: bigint;
  totalLongSize: bigint;
  totalShortSize: bigint;
}

export interface MatchExecution {
  longIntentCommitment: Hex;
  longLimitPrice: bigint;
  longNoteNullifier: Hex;
  longPositionCommitment: Hex;
  makerIntentCommitment: Hex;
  makerSide: "long" | "short";
  price: bigint;
  shortIntentCommitment: Hex;
  shortLimitPrice: bigint;
  shortNoteNullifier: Hex;
  shortPositionCommitment: Hex;
  size: bigint;
  takerIntentCommitment: Hex;
}
