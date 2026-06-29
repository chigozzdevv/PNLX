import { BlindComputeService } from "@/workers/blind-compute/blind-compute.service";
import type { BlindComputeConfig } from "@/workers/blind-compute/blind-compute.model";

export function createBlindCompute(config: BlindComputeConfig): BlindComputeService {
  return new BlindComputeService(config);
}
