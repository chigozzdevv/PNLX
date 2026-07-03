import type { BatchSettlement, Hex, MarketConfig, PrivateMatchIntent } from "@pnlx/protocol-types";
import type { MatchResult } from "@/workers/batch-matcher/batch-matcher.model";

export interface SettlementProofInput {
  batchId: string;
  market: MarketConfig;
  oldRoot: Hex;
  newRoot: Hex;
  positionCommitments: Hex[];
  intents: PrivateMatchIntent[];
  match: MatchResult;
}

export type SettlementProof = BatchSettlement;
