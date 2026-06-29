import type { Router } from "../../shared/http/router";
import type { ServerEnv } from "../../config/env";
import type { ExecutorService } from "../../workers/executor/executor.service";
import type { OnchainRelayService } from "../../workers/onchain/onchain.service";
import type { ProverService } from "../../workers/prover/prover.service";
import { DisclosuresController } from "./disclosures.controller";
import { DisclosuresService } from "./disclosures.service";

export function registerDisclosuresRoute(
  router: Router,
  executor: ExecutorService,
  prover: ProverService,
  env: ServerEnv,
  onchain?: OnchainRelayService,
  options: { witnessRoutesEnabled?: boolean } = {},
): void {
  const controller = new DisclosuresController(new DisclosuresService(executor, prover, onchain, env));
  router.add("POST", "/disclosures/proven", (request) => controller.createProven(request));
  if (options.witnessRoutesEnabled) {
    router.add("POST", "/disclosures", (request) => controller.create(request));
  }
}
