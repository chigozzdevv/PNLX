import type { BatchSettlement, Hex, MarketConfig } from "@pnlx/protocol-types";
import type { MatchResult } from "@/workers/batch-matcher/batch-matcher.model";
import type { RecoveredIntent } from "@/workers/threshold-shares/threshold-shares.model";

export interface SettlementProofInput {
  batchId: string;
  market: MarketConfig;
  oldRoot: Hex;
  newRoot: Hex;
  positionCommitments: Hex[];
  intents: RecoveredIntent[];
  match: MatchResult;
}

export type SettlementProof = BatchSettlement;
