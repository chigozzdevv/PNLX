import type { CommitteeSettlementInput } from "@/workers/threshold-shares/threshold-shares.model";

export interface MatcherProviderConfig {
  thresholdShareNodeIds: string[];
  thresholdShareStoreDir?: string;
  thresholdShareThreshold: number;
}

export interface MatcherProviderSettlementRequest extends CommitteeSettlementInput {}
