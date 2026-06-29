import type { CommitteeSettlementInput } from "../mpc-node/mpc-node.model";

export interface BlindComputeConfig {
  mpcNodeIds: string[];
  mpcShareStoreDir?: string;
  mpcThreshold: number;
}

export interface BlindComputeSettlementRequest extends CommitteeSettlementInput {}
