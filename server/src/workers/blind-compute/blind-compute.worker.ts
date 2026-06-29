import { BlindComputeService } from "./blind-compute.service";
import type { BlindComputeConfig } from "./blind-compute.model";

export function createBlindCompute(config: BlindComputeConfig): BlindComputeService {
  return new BlindComputeService(config);
}
