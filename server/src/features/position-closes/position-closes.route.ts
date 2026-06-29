import type { Router } from "@/shared/http/router";
import type { ServerEnv } from "@/config/env";
import type { ExecutorService } from "@/workers/executor/executor.service";
import type { OnchainRelayService } from "@/workers/onchain/onchain.service";
import type { ProverService } from "@/workers/prover/prover.service";
import { PositionClosesController } from "@/features/position-closes/position-closes.controller";
import { PositionClosesService } from "@/features/position-closes/position-closes.service";

export function registerPositionClosesRoute(
  router: Router,
  executor: ExecutorService,
  prover: ProverService,
  env: ServerEnv,
  onchain?: OnchainRelayService,
  options: { witnessRoutesEnabled?: boolean } = {},
): void {
  const controller = new PositionClosesController(new PositionClosesService(executor, prover, onchain, env));
  router.add("POST", "/position-closes/proven", (request) => controller.createProven(request));
  router.add("POST", "/position-closes/manual-proven", (request) => controller.createManualProven(request));
  if (options.witnessRoutesEnabled) {
    router.add("POST", "/position-closes", (request) => controller.create(request));
    router.add("POST", "/position-closes/manual", (request) => controller.createManual(request));
  }
}
