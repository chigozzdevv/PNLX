import type { BatchSettlement, MarketConfig, PrivateMatchIntent } from "@pnlx/protocol-types";
import type { MatchResult } from "@/workers/batch-matcher/batch-matcher.model";

export interface SettlementProofInput {
  batchId: string;
  market: MarketConfig;
  intents: PrivateMatchIntent[];
  match: MatchResult;
}

export type SettlementProof = BatchSettlement;
