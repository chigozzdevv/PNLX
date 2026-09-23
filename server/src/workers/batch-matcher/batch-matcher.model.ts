import type { Fill, Hex, MarketConfig, OrderLifecycleUpdate, PrivateMatchIntent } from "@pnlx/protocol-types";

export interface MatchInput {
  batchId: string;
  market: MarketConfig;
  intents: PrivateMatchIntent[];
}

export interface MatchResult {
  executions: MatchExecution[];
  fills: Fill[];
  fees: {
    grossTakerFee: bigint;
    makerRebate: bigint;
    insurance: bigint;
    treasury: bigint;
  };
  matchTranscriptDigest: Hex;
  marginChangeCommitments: Hex[];
  orderUpdates: OrderLifecycleUpdate[];
  residuals: PrivateMatchIntent[];
  spentNullifiers: Hex[];
  aggregateVolume: bigint;
  openInterestDelta: bigint;
  residualSize: bigint;
  totalLongSize: bigint;
  totalShortSize: bigint;
}

export interface MatchExecution {
  grossTakerFee: bigint;
  makerRebate: bigint;
  insurance: bigint;
  treasury: bigint;
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
