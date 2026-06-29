import type { ExecutorService } from "../executor/executor.service";
import type { OnchainRelay } from "../onchain/onchain.model";
import type { Prover } from "../prover/prover.model";
import { FundingEngineService } from "./funding-engine.service";
import type { FundingEngineConfig } from "./funding-engine.model";

export function createFundingEngine(
  executor: ExecutorService,
  config?: FundingEngineConfig,
  prover?: Prover,
  onchain?: OnchainRelay,
): FundingEngineService {
  return new FundingEngineService(executor, config, prover, onchain);
}
