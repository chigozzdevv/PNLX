import type { BatchSettlement, Hex, MarketConfig } from "@merkl/protocol-types";
import type { MatchResult } from "@/workers/batch-matcher/batch-matcher.model";

export interface SettlementProofInput {
  batchId: string;
  market: MarketConfig;
  oldRoot: Hex;
  newRoot: Hex;
  match: MatchResult;
}

export type SettlementProof = BatchSettlement;
