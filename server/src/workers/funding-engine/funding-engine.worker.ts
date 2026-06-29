import type { ExecutorService } from "@/workers/executor/executor.service";
import type { OnchainRelay } from "@/workers/onchain/onchain.model";
import type { Prover } from "@/workers/prover/prover.model";
import { FundingEngineService } from "@/workers/funding-engine/funding-engine.service";
import type { FundingEngineConfig } from "@/workers/funding-engine/funding-engine.model";

export function createFundingEngine(
  executor: ExecutorService,
  config?: FundingEngineConfig,
  prover?: Prover,
  onchain?: OnchainRelay,
): FundingEngineService {
  return new FundingEngineService(executor, config, prover, onchain);
}
