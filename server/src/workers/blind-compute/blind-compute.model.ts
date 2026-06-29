import type { CommitteeSettlementInput } from "@/workers/threshold-shares/threshold-shares.model";

export interface BlindComputeConfig {
  thresholdShareNodeIds: string[];
  thresholdShareStoreDir?: string;
  thresholdShareThreshold: number;
}

export interface BlindComputeSettlementRequest extends CommitteeSettlementInput {}
