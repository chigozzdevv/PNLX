import type { Router } from "@/shared/http/router";
import type { ServerEnv } from "@/config/env";
import type { ExecutorService } from "@/workers/executor/executor.service";
import type { OnchainRelayService } from "@/workers/onchain/onchain.service";
import type { ProverService } from "@/workers/prover/prover.service";
import { LiquidationsController } from "@/features/liquidations/liquidations.controller";
import { LiquidationsService } from "@/features/liquidations/liquidations.service";

export function registerLiquidationsRoute(
  router: Router,
  executor: ExecutorService,
  prover: ProverService,
  env: ServerEnv,
  onchain?: OnchainRelayService,
  options: { witnessRoutesEnabled?: boolean } = {},
): void {
  const controller = new LiquidationsController(new LiquidationsService(executor, prover, onchain, env));
  router.add("POST", "/liquidations/proven", (request) => controller.createProven(request));
  if (options.witnessRoutesEnabled) {
    router.add("POST", "/liquidations", (request) => controller.create(request));
  }
}
